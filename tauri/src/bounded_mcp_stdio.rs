/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

//! Bounded stdio framing for MCP child processes.
//!
//! rmcp's stdio reader accumulates a complete JSON-RPC line before parsing it.
//! This adapter rejects oversized lines while bytes are read, before they can
//! grow rmcp's per-message buffer without limit.

use std::{
    future::Future,
    io,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
    time::Duration,
};

use process_wrap::tokio::{ChildWrapper, CommandWrap};
use rmcp::{
    service::{RoleClient, RxJsonRpcMessage, TxJsonRpcMessage},
    transport::{async_rw::AsyncRwTransport, Transport},
};
use tokio::{
    io::{AsyncRead, ReadBuf},
    process::{ChildStdin, ChildStdout, Command},
};

const READ_CHUNK_BYTES: usize = 4 * 1024;
const CHILD_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

/// A stdio MCP transport that caps each inbound JSON-RPC line before parsing.
pub struct BoundedMcpStdioTransport {
    child: ChildGuard,
    transport: AsyncRwTransport<RoleClient, BoundedLineReader<ChildStdout>, ChildStdin>,
}

impl BoundedMcpStdioTransport {
    /// Spawns a child and rejects any inbound line above `max_line_bytes`.
    pub fn spawn(command: Command, max_line_bytes: usize) -> io::Result<Self> {
        if max_line_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "MCP stdio line limit must be greater than zero",
            ));
        }

        let mut command = CommandWrap::from(command);
        command
            .command_mut()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = ChildGuard {
            inner: Some(command.spawn()?),
        };
        let stdin = child
            .inner_mut()
            .stdin()
            .take()
            .ok_or_else(|| io::Error::other("MCP child stdin was not piped"))?;
        let stdout = child
            .inner_mut()
            .stdout()
            .take()
            .ok_or_else(|| io::Error::other("MCP child stdout was not piped"))?;

        Ok(Self {
            child,
            transport: AsyncRwTransport::new_client(
                BoundedLineReader::new(stdout, max_line_bytes),
                stdin,
            ),
        })
    }
}

impl Transport<RoleClient> for BoundedMcpStdioTransport {
    type Error = io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.transport.send(item)
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.transport.receive()
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        let close_transport = self.transport.close();
        let child = &mut self.child;
        async move {
            let transport_result = close_transport.await;
            let child_result = child.graceful_shutdown().await;
            transport_result?;
            child_result
        }
    }
}

struct ChildGuard {
    inner: Option<Box<dyn ChildWrapper>>,
}

impl ChildGuard {
    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        self.inner
            .as_deref_mut()
            .expect("MCP child process is already closed")
    }

    async fn graceful_shutdown(&mut self) -> io::Result<()> {
        match self.inner.take() {
            Some(mut child) => {
                match tokio::time::timeout(CHILD_SHUTDOWN_TIMEOUT, child.wait()).await {
                    Ok(result) => result.map(|_| ()),
                    Err(_) => Box::into_pin(child.kill()).await,
                }
            }
            None => Ok(()),
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.inner.take() else {
            return;
        };

        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = Box::into_pin(child.kill()).await;
            });
        } else {
            let _ = child.inner_mut().start_kill();
        }
    }
}

/// An asynchronous reader that checks line length before forwarding bytes.
pub struct BoundedLineReader<R> {
    inner: R,
    line_bytes: usize,
    max_line_bytes: usize,
}

impl<R> BoundedLineReader<R> {
    pub fn new(inner: R, max_line_bytes: usize) -> Self {
        Self {
            inner,
            line_bytes: 0,
            max_line_bytes,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for BoundedLineReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        let mut chunk = [0_u8; READ_CHUNK_BYTES];
        let read_limit = output.remaining().min(READ_CHUNK_BYTES);
        let mut input = ReadBuf::new(&mut chunk[..read_limit]);
        match Pin::new(&mut this.inner).poll_read(cx, &mut input) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Ready(Ok(())) => {
                let bytes = input.filled();
                if bytes.is_empty() {
                    return Poll::Ready(Ok(()));
                }

                let mut line_bytes = this.line_bytes;
                for byte in bytes {
                    if *byte == b'\n' {
                        line_bytes = 0;
                    } else {
                        line_bytes += 1;
                        if line_bytes > this.max_line_bytes {
                            return Poll::Ready(Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "MCP stdio response line exceeded the configured size limit",
                            )));
                        }
                    }
                }

                this.line_bytes = line_bytes;
                output.put_slice(bytes);
                Poll::Ready(Ok(()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::BoundedLineReader;
    use std::io;
    use tokio::io::AsyncReadExt;

    const LIMIT: usize = 64 * 1024;

    #[tokio::test]
    async fn accepts_a_line_at_the_limit_and_resets_after_newline() {
        let mut input = vec![b'x'; LIMIT];
        input.extend_from_slice(b"\n{}\n");
        let expected = input.clone();
        let mut reader = BoundedLineReader::new(io::Cursor::new(input), LIMIT);
        let mut output = Vec::new();

        reader.read_to_end(&mut output).await.unwrap();

        assert_eq!(output, expected);
    }

    #[tokio::test]
    async fn rejects_an_oversized_line_before_forwarding_the_overflow() {
        let input = vec![b'x'; LIMIT + 1];
        let mut reader = BoundedLineReader::new(io::Cursor::new(input), LIMIT);
        let mut output = Vec::new();

        let error = reader.read_to_end(&mut output).await.unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(output.len() <= LIMIT);
    }
}
