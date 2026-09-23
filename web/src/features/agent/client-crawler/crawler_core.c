/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
/*
 * Small, deterministic HTML-to-text core for the browser-side crawler.
 * The browser host owns network access; this WASM module only parses the
 * bounded response body that the user explicitly asked the Agent to read.
 */
typedef unsigned int u32;
typedef unsigned char u8;

static int is_space(u8 value) {
  return value == ' ' || value == '\t' || value == '\r' || value == '\n' || value == '\f';
}

static u8 lower_ascii(u8 value) {
  return value >= 'A' && value <= 'Z' ? (u8)(value + ('a' - 'A')) : value;
}

static int starts_with_ci(const u8 *input, u32 length, u32 offset, const char *value) {
  u32 index = 0;
  while (value[index] != 0) {
    if (offset + index >= length || lower_ascii(input[offset + index]) != (u8)value[index]) return 0;
    index++;
  }
  return 1;
}

static int tag_is(const u8 *input, u32 start, u32 length, const char *name) {
  u32 index = 0;
  while (name[index] != 0) {
    if (index >= length || lower_ascii(input[start + index]) != (u8)name[index]) return 0;
    index++;
  }
  return index == length;
}

static int block_tag(const u8 *input, u32 start, u32 length) {
  return tag_is(input, start, length, "p") || tag_is(input, start, length, "div") ||
         tag_is(input, start, length, "br") || tag_is(input, start, length, "li") ||
         tag_is(input, start, length, "ul") || tag_is(input, start, length, "ol") ||
         tag_is(input, start, length, "h1") || tag_is(input, start, length, "h2") ||
         tag_is(input, start, length, "h3") || tag_is(input, start, length, "h4") ||
         tag_is(input, start, length, "h5") || tag_is(input, start, length, "h6") ||
         tag_is(input, start, length, "section") || tag_is(input, start, length, "article") ||
         tag_is(input, start, length, "header") || tag_is(input, start, length, "footer") ||
         tag_is(input, start, length, "tr") || tag_is(input, start, length, "td") ||
         tag_is(input, start, length, "th") || tag_is(input, start, length, "blockquote") ||
         tag_is(input, start, length, "main") || tag_is(input, start, length, "summary");
}

static u32 append_codepoint(u8 *output, u32 output_length, u32 capacity, u32 codepoint) {
  if (codepoint <= 0x7f) {
    if (output_length < capacity) output[output_length++] = (u8)codepoint;
  } else if (codepoint <= 0x7ff) {
    if (output_length + 2 <= capacity) {
      output[output_length++] = (u8)(0xc0 | (codepoint >> 6));
      output[output_length++] = (u8)(0x80 | (codepoint & 0x3f));
    }
  } else if (codepoint <= 0xffff) {
    if (output_length + 3 <= capacity) {
      output[output_length++] = (u8)(0xe0 | (codepoint >> 12));
      output[output_length++] = (u8)(0x80 | ((codepoint >> 6) & 0x3f));
      output[output_length++] = (u8)(0x80 | (codepoint & 0x3f));
    }
  } else if (codepoint <= 0x10ffff) {
    if (output_length + 4 <= capacity) {
      output[output_length++] = (u8)(0xf0 | (codepoint >> 18));
      output[output_length++] = (u8)(0x80 | ((codepoint >> 12) & 0x3f));
      output[output_length++] = (u8)(0x80 | ((codepoint >> 6) & 0x3f));
      output[output_length++] = (u8)(0x80 | (codepoint & 0x3f));
    }
  }
  return output_length;
}

static int entity(const u8 *input, u32 length, u32 offset, u32 *consumed, u32 *codepoint) {
  u32 end = offset + 1;
  while (end < length && end - offset <= 12 && input[end] != ';' && !is_space(input[end]) && input[end] != '<') end++;
  if (end >= length || input[end] != ';') return 0;
  u32 body = offset + 1;
  u32 body_length = end - body;
  if (body_length == 3 && starts_with_ci(input, length, body, "amp")) *codepoint = '&';
  else if (body_length == 2 && starts_with_ci(input, length, body, "lt")) *codepoint = '<';
  else if (body_length == 2 && starts_with_ci(input, length, body, "gt")) *codepoint = '>';
  else if (body_length == 4 && starts_with_ci(input, length, body, "quot")) *codepoint = '"';
  else if (body_length == 4 && starts_with_ci(input, length, body, "apos")) *codepoint = '\'';
  else if (body_length == 4 && starts_with_ci(input, length, body, "nbsp")) *codepoint = ' ';
  else if (body_length >= 2 && input[body] == '#') {
    u32 cursor = body + 1;
    u32 base = 10;
    if (cursor < end && (input[cursor] == 'x' || input[cursor] == 'X')) { base = 16; cursor++; }
    u32 value = 0;
    if (cursor == end) return 0;
    for (; cursor < end; cursor++) {
      u8 ch = input[cursor];
      u32 digit;
      if (ch >= '0' && ch <= '9') digit = (u32)(ch - '0');
      else if (base == 16 && lower_ascii(ch) >= 'a' && lower_ascii(ch) <= 'f') digit = (u32)(lower_ascii(ch) - 'a' + 10);
      else return 0;
      if (digit >= base || value > 0x10ffff / base) return 0;
      value = value * base + digit;
    }
    if (value == 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return 0;
    *codepoint = value;
  } else return 0;
  *consumed = end - offset + 1;
  return 1;
}

static u32 append_space(u8 *output, u32 output_length, u32 capacity, u8 value) {
  if (output_length == 0) return output_length;
  if (output[output_length - 1] == '\n' || output[output_length - 1] == ' ') return output_length;
  if (output_length < capacity) output[output_length++] = value;
  return output_length;
}

__attribute__((export_name("extract_html_text")))
u32 extract_html_text(const u8 *input, u32 input_length, u8 *output, u32 output_capacity) {
  if (input == 0 || output == 0 || output_capacity == 0) return 0;
  u32 input_offset = 0;
  u32 output_length = 0;
  while (input_offset < input_length && output_length < output_capacity) {
    if (input_offset + 4 <= input_length && input[input_offset] == '<' && input[input_offset + 1] == '!' && input[input_offset + 2] == '-' && input[input_offset + 3] == '-') {
      input_offset += 4;
      while (input_offset + 2 < input_length && !(input[input_offset] == '-' && input[input_offset + 1] == '-' && input[input_offset + 2] == '>')) input_offset++;
      if (input_offset + 2 < input_length) input_offset += 3;
      continue;
    }
    if (input[input_offset] == '<') {
      u32 tag_start = input_offset + 1;
      int closing = tag_start < input_length && input[tag_start] == '/';
      if (closing) tag_start++;
      while (tag_start < input_length && is_space(input[tag_start])) tag_start++;
      u32 tag_end = tag_start;
      while (tag_end < input_length && !is_space(input[tag_end]) && input[tag_end] != '>' && input[tag_end] != '/') tag_end++;
      if (tag_end > tag_start) {
        u32 after_tag = tag_end;
        while (after_tag < input_length && input[after_tag] != '>') after_tag++;
        if (after_tag < input_length) {
          if (tag_is(input, tag_start, tag_end - tag_start, "script") || tag_is(input, tag_start, tag_end - tag_start, "style") || tag_is(input, tag_start, tag_end - tag_start, "noscript") || tag_is(input, tag_start, tag_end - tag_start, "template") || tag_is(input, tag_start, tag_end - tag_start, "svg")) {
            if (!closing) {
              const char *name = tag_is(input, tag_start, tag_end - tag_start, "script") ? "</script" :
                                 tag_is(input, tag_start, tag_end - tag_start, "style") ? "</style" :
                                 tag_is(input, tag_start, tag_end - tag_start, "noscript") ? "</noscript" :
                                 tag_is(input, tag_start, tag_end - tag_start, "template") ? "</template" : "</svg";
              input_offset = after_tag + 1;
              while (input_offset < input_length && !starts_with_ci(input, input_length, input_offset, name)) input_offset++;
              while (input_offset < input_length && input[input_offset] != '>') input_offset++;
              if (input_offset < input_length) input_offset++;
              continue;
            }
          }
          if (block_tag(input, tag_start, tag_end - tag_start)) output_length = append_space(output, output_length, output_capacity, '\n');
          input_offset = after_tag + 1;
          continue;
        }
      }
    }
    if (input[input_offset] == '&') {
      u32 consumed = 0, codepoint = 0;
      if (entity(input, input_length, input_offset, &consumed, &codepoint)) {
        if (codepoint == ' ' || codepoint == '\t' || codepoint == '\n' || codepoint == '\r') output_length = append_space(output, output_length, output_capacity, ' ');
        else output_length = append_codepoint(output, output_length, output_capacity, codepoint);
        input_offset += consumed;
        continue;
      }
    }
    u8 value = input[input_offset++];
    if (is_space(value)) output_length = append_space(output, output_length, output_capacity, ' ');
    else if (output_length < output_capacity) output[output_length++] = value;
  }
  while (output_length > 0 && (output[output_length - 1] == ' ' || output[output_length - 1] == '\n')) output_length--;
  return output_length;
}
