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
 * Bounded, read-only binary metadata parser for the browser WASM runtime.
 * The host passes at most a 64 KiB prefix. This module has no imports,
 * filesystem, network, or cookie access and never returns raw file bytes.
 */
typedef unsigned char u8;
typedef unsigned int u32;

static int put_char(u8 *output, u32 capacity, u32 *used, u8 value) {
  if (*used >= capacity) return 0;
  output[(*used)++] = value;
  return 1;
}

static int put_text(u8 *output, u32 capacity, u32 *used, const char *value) {
  u32 index = 0;
  while (value[index] != 0) {
    if (!put_char(output, capacity, used, (u8)value[index])) return 0;
    index++;
  }
  return 1;
}

static int put_number(u8 *output, u32 capacity, u32 *used, u32 value) {
  u8 digits[10];
  u32 count = 0;
  do {
    digits[count++] = (u8)('0' + value % 10);
    value /= 10;
  } while (value != 0 && count < 10);
  while (count > 0) {
    if (!put_char(output, capacity, used, digits[--count])) return 0;
  }
  return 1;
}

static int put_member_prefix(u8 *output, u32 capacity, u32 *used,
                             const char *name, int *first) {
  if (!*first && !put_char(output, capacity, used, ',')) return 0;
  *first = 0;
  return put_char(output, capacity, used, '"') &&
         put_text(output, capacity, used, name) &&
         put_text(output, capacity, used, "\":");
}

static int put_string_member(u8 *output, u32 capacity, u32 *used,
                             const char *name, const char *value,
                             int *first) {
  return put_member_prefix(output, capacity, used, name, first) &&
         put_char(output, capacity, used, '"') &&
         put_text(output, capacity, used, value) &&
         put_char(output, capacity, used, '"');
}

static int put_number_member(u8 *output, u32 capacity, u32 *used,
                             const char *name, u32 value, int *first) {
  return put_member_prefix(output, capacity, used, name, first) &&
         put_number(output, capacity, used, value);
}

static int put_bool_member(u8 *output, u32 capacity, u32 *used,
                           const char *name, int value, int *first) {
  return put_member_prefix(output, capacity, used, name, first) &&
         put_text(output, capacity, used, value ? "true" : "false");
}

static int begin_result(u8 *output, u32 capacity, u32 *used,
                        const char *format, int recognized) {
  int first = 1;
  return put_char(output, capacity, used, '{') &&
         put_string_member(output, capacity, used, "format", format, &first) &&
         put_bool_member(output, capacity, used, "recognized", recognized, &first);
}

static int finish_result(u8 *output, u32 capacity, u32 used) {
  return put_char(output, capacity, &used, '}') ? (int)used : -1;
}

static u32 read_u16(const u8 *input, u32 offset, int little_endian) {
  if (little_endian) return (u32)input[offset] | ((u32)input[offset + 1] << 8);
  return ((u32)input[offset] << 8) | (u32)input[offset + 1];
}

static u32 read_u32_le(const u8 *input, u32 offset) {
  return (u32)input[offset] | ((u32)input[offset + 1] << 8) |
         ((u32)input[offset + 2] << 16) | ((u32)input[offset + 3] << 24);
}

static u32 read_u32(const u8 *input, u32 offset, int little_endian) {
  if (little_endian) return read_u32_le(input, offset);
  return ((u32)input[offset] << 24) | ((u32)input[offset + 1] << 16) |
         ((u32)input[offset + 2] << 8) | (u32)input[offset + 3];
}

static const char *elf_architecture(u32 machine) {
  if (machine == 3) return "x86";
  if (machine == 40) return "ARM";
  if (machine == 62) return "x86_64";
  if (machine == 183) return "AArch64";
  if (machine == 243) return "RISC-V";
  return "unknown";
}

static const char *pe_architecture(u32 machine) {
  if (machine == 0x014c) return "x86";
  if (machine == 0x01c0 || machine == 0x01c4) return "ARM";
  if (machine == 0x8664) return "x86_64";
  if (machine == 0xaa64) return "ARM64";
  return "unknown";
}

static const char *macho_architecture(u32 cpu) {
  if (cpu == 7) return "x86";
  if (cpu == 0x01000007) return "x86_64";
  if (cpu == 12) return "ARM";
  if (cpu == 0x0100000c) return "ARM64";
  return "unknown";
}

static int analyze_elf(const u8 *input, u32 length, u8 *output,
                       u32 capacity, u32 *used) {
  int first = 1;
  if (!begin_result(output, capacity, used, "ELF executable", 1)) return -1;
  if (length < 20 || input[4] < 1 || input[4] > 2 ||
      input[5] < 1 || input[5] > 2) {
    if (!put_bool_member(output, capacity, used, "malformed", 1, &first)) return -1;
    return finish_result(output, capacity, *used);
  }
  if (!put_number_member(output, capacity, used, "bitness", input[4] == 1 ? 32 : 64, &first) ||
      !put_string_member(output, capacity, used, "endianness", input[5] == 1 ? "little" : "big", &first) ||
      !put_string_member(output, capacity, used, "architecture", elf_architecture(read_u16(input, 18, input[5] == 1)), &first) ||
      !put_number_member(output, capacity, used, "objectType", read_u16(input, 16, input[5] == 1), &first)) return -1;
  return finish_result(output, capacity, *used);
}

static int analyze_pe(const u8 *input, u32 length, u8 *output,
                      u32 capacity, u32 *used) {
  u32 header = length >= 64 ? read_u32_le(input, 0x3c) : length;
  int first = 1;
  if (!begin_result(output, capacity, used, "PE executable", 1)) return -1;
  if (header > length || length - header < 24 || input[header] != 'P' ||
      input[header + 1] != 'E' || input[header + 2] != 0 || input[header + 3] != 0) {
    if (!put_bool_member(output, capacity, used, "malformed", 1, &first)) return -1;
    return finish_result(output, capacity, *used);
  }
  if (!put_string_member(output, capacity, used, "architecture", pe_architecture(read_u16(input, header + 4, 1)), &first) ||
      !put_number_member(output, capacity, used, "sectionCount", read_u16(input, header + 6, 1), &first)) return -1;
  return finish_result(output, capacity, *used);
}

static int is_macho(const u8 *input, u32 length) {
  if (length < 8) return 0;
  return (input[0] == 0xfe && input[1] == 0xed && input[2] == 0xfa &&
          (input[3] == 0xce || input[3] == 0xcf)) ||
         ((input[0] == 0xce || input[0] == 0xcf) && input[1] == 0xfa &&
          input[2] == 0xed && input[3] == 0xfe) ||
         (input[0] == 0xca && input[1] == 0xfe && input[2] == 0xba && input[3] == 0xbe) ||
         (input[0] == 0xbe && input[1] == 0xba && input[2] == 0xfe && input[3] == 0xca);
}

static int analyze_macho(const u8 *input, u32 length, u8 *output,
                         u32 capacity, u32 *used) {
  int fat = length >= 4 && ((input[0] == 0xca && input[1] == 0xfe) ||
                            (input[0] == 0xbe && input[1] == 0xba));
  int little = input[0] == 0xce || input[0] == 0xcf || input[0] == 0xbe;
  int first = 1;
  if (!begin_result(output, capacity, used, fat ? "Universal Mach-O" : "Mach-O executable", 1)) return -1;
  if (length < 8) {
    if (!put_bool_member(output, capacity, used, "malformed", 1, &first)) return -1;
    return finish_result(output, capacity, *used);
  }
  if (!put_string_member(output, capacity, used, "architecture",
                         fat ? "universal" : macho_architecture(read_u32(input, 4, little)), &first) ||
      !put_string_member(output, capacity, used, "endianness", little ? "little" : "big", &first)) return -1;
  if (fat) {
    if (!put_number_member(output, capacity, used, "architectureCount",
                           read_u32(input, 4, little), &first)) return -1;
  } else if (!put_number_member(output, capacity, used, "bitness",
                                input[0] == 0xcf || input[3] == 0xcf ? 64 : 32, &first)) {
    return -1;
  }
  return finish_result(output, capacity, *used);
}

static const char *wasm_section_name(u8 id) {
  if (id == 0) return "custom";
  if (id == 1) return "type";
  if (id == 2) return "import";
  if (id == 3) return "function";
  if (id == 4) return "table";
  if (id == 5) return "memory";
  if (id == 6) return "global";
  if (id == 7) return "export";
  if (id == 8) return "start";
  if (id == 9) return "element";
  if (id == 10) return "code";
  if (id == 11) return "data";
  if (id == 12) return "data-count";
  if (id == 13) return "tag";
  return "unknown";
}

static int read_uleb32(const u8 *input, u32 length, u32 total_length,
                       u32 *cursor, u32 *value) {
  u32 result = 0;
  u32 shift = 0;
  u32 count = 0;
  while (*cursor < length && count < 5) {
    u8 byte = input[(*cursor)++];
    if (shift == 28 && (byte & 0xf0) != 0) return 0;
    result |= (u32)(byte & 0x7f) << shift;
    count++;
    if ((byte & 0x80) == 0) {
      *value = result;
      return 1;
    }
    shift += 7;
  }
  if (count >= 5) return 0;
  return *cursor >= length && total_length > length ? -1 : 0;
}

static int append_wasm_section(u8 *output, u32 capacity, u32 *used,
                              int *first, u8 id, u32 bytes) {
  int field = 1;
  if (!*first && !put_char(output, capacity, used, ',')) return 0;
  *first = 0;
  return put_char(output, capacity, used, '{') &&
         put_number_member(output, capacity, used, "id", id, &field) &&
         put_string_member(output, capacity, used, "name", wasm_section_name(id), &field) &&
         put_number_member(output, capacity, used, "bytes", bytes, &field) &&
         put_char(output, capacity, used, '}');
}

static int append_wasm_sections(const u8 *input, u32 length, u8 *output,
                                u32 total_length, u32 capacity, u32 *used,
                                u32 *count, int *malformed, int *truncated,
                                int *incomplete) {
  u32 cursor = 8;
  u32 shown = 0;
  int first = 1;
  if (!put_char(output, capacity, used, '[')) return 0;
  while (cursor < length) {
    u8 id = input[cursor++];
    u32 section_bytes = 0;
    int leb_status = read_uleb32(input, length, total_length, &cursor, &section_bytes);
    if (leb_status != 1) {
      if (leb_status < 0) *incomplete = 1;
      else *malformed = 1;
      break;
    }
    if (cursor > total_length || section_bytes > total_length - cursor) {
      *malformed = 1;
      break;
    }
    (*count)++;
    if (shown < 16) {
      if (!append_wasm_section(output, capacity, used, &first, id, section_bytes)) return 0;
      shown++;
    } else {
      *truncated = 1;
    }
    if (section_bytes > length - cursor) {
      *incomplete = 1;
      break;
    }
    cursor += section_bytes;
  }
  if (!*malformed && cursor < total_length && length < total_length) {
    *incomplete = 1;
  }
  return put_char(output, capacity, used, ']');
}

static int analyze_wasm(const u8 *input, u32 length, u8 *output,
                        u32 total_length, u32 capacity, u32 *used) {
  u32 section_count = 0;
  int malformed = length < 8;
  int truncated = 0;
  int incomplete = 0;
  int first = 1;
  if (!begin_result(output, capacity, used, "WebAssembly", 1)) return -1;
  if (length >= 8 && !put_number_member(output, capacity, used, "version", read_u32_le(input, 4), &first)) return -1;
  if (!put_member_prefix(output, capacity, used, "sections", &first) ||
      !append_wasm_sections(input, length, total_length, output, capacity, used,
                            &section_count, &malformed, &truncated, &incomplete) ||
      !put_number_member(output, capacity, used, "sectionCount", section_count, &first) ||
      !put_bool_member(output, capacity, used, "malformed", malformed, &first) ||
      !put_bool_member(output, capacity, used, "sectionsTruncated", truncated, &first) ||
      !put_bool_member(output, capacity, used, "sectionsIncomplete", incomplete, &first)) return -1;
  return finish_result(output, capacity, *used);
}

static int analyze_zip(const u8 *input, u32 length, u8 *output,
                       u32 capacity, u32 *used) {
  int first = 1;
  if (!begin_result(output, capacity, used, "ZIP archive", 1)) return -1;
  if (length < 4) {
    if (!put_bool_member(output, capacity, used, "malformed", 1, &first)) return -1;
  }
  return finish_result(output, capacity, *used);
}

static int analyze_unknown(u8 *output, u32 capacity, u32 *used) {
  int first = 0;
  if (!begin_result(output, capacity, used, "Unknown binary", 0)) return -1;
  if (!put_string_member(output, capacity, used, "note", "Format signature not recognized; raw bytes are omitted.", &first)) return -1;
  return finish_result(output, capacity, *used);
}

__attribute__((export_name("analyze_binary")))
int analyze_binary(u32 input_pointer, u32 input_length,
                   u32 output_pointer, u32 output_capacity,
                   u32 total_length) {
  const u8 *input = (const u8 *)input_pointer;
  u8 *output = (u8 *)output_pointer;
  u32 used = 0;
  if (total_length < input_length) total_length = input_length;
  if (output_capacity < 64) return -1;
  if (input_length >= 4 && input[0] == 0 && input[1] == 'a' &&
      input[2] == 's' && input[3] == 'm') {
    return analyze_wasm(input, input_length, output, total_length, output_capacity, &used);
  }
  if (input_length >= 4 && input[0] == 0x7f && input[1] == 'E' &&
      input[2] == 'L' && input[3] == 'F') {
    return analyze_elf(input, input_length, output, output_capacity, &used);
  }
  if (input_length >= 2 && input[0] == 'M' && input[1] == 'Z') {
    return analyze_pe(input, input_length, output, output_capacity, &used);
  }
  if (is_macho(input, input_length)) {
    return analyze_macho(input, input_length, output, output_capacity, &used);
  }
  if (input_length >= 4 && input[0] == 'P' && input[1] == 'K' &&
      ((input[2] == 3 && input[3] == 4) || (input[2] == 5 && input[3] == 6) ||
       (input[2] == 7 && input[3] == 8))) {
    return analyze_zip(input, input_length, output, output_capacity, &used);
  }
  return analyze_unknown(output, output_capacity, &used);
}
