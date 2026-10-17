use std::sync::atomic::{AtomicU8, Ordering, compiler_fence};

use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use crate::protocol::wire::JsonRpcError;

use super::{Client, Delivery, Error, REQUEST_DEADLINE};

const HEADER_LIMIT: usize = 16 * 1024;
const NOT_SENT: u8 = 0;
const UNKNOWN: u8 = 1;
const RECEIVED: u8 = 2;

impl Client {
    pub async fn read_file(&self, agent_id: &str, path: &str) -> Result<Vec<u8>, Error> {
        let target = file_target(agent_id, path)?;
        self.http("GET", &target, &[], None, &CancellationToken::new())
            .await
    }

    pub async fn write_file(&self, agent_id: &str, path: &str, bytes: &[u8]) -> Result<(), Error> {
        let target = file_target(agent_id, path)?;
        self.http(
            "PUT",
            &target,
            bytes,
            Some("application/octet-stream"),
            &CancellationToken::new(),
        )
        .await?;
        Ok(())
    }

    pub async fn upload_media(
        &self,
        agent_id: &str,
        session_id: &str,
        file_name: &str,
        mime_type: &str,
        bytes: &[u8],
    ) -> Result<Value, Error> {
        if mime_type.is_empty()
            || !mime_type
                .bytes()
                .all(|byte| byte.is_ascii_graphic() || byte == b' ')
        {
            return Err(Error::local("invalid_params", Delivery::NotSent));
        }
        let target = format!(
            "/media/{}/{}?fileName={}&mimeType={}",
            segment(agent_id)?,
            segment(session_id)?,
            encode(file_name),
            encode(mime_type)
        );
        let body = self
            .http(
                "PUT",
                &target,
                bytes,
                Some(mime_type),
                &CancellationToken::new(),
            )
            .await?;
        serde_json::from_slice(&body)
            .map_err(|_| Error::local("protocol", Delivery::ResponseReceived))
    }

    pub async fn take_media(
        &self,
        agent_id: &str,
        session_id: &str,
        reference: &str,
    ) -> Result<Vec<u8>, Error> {
        let target = format!(
            "/media/{}/{}/{}",
            segment(agent_id)?,
            segment(session_id)?,
            segment(reference)?
        );
        self.http("POST", &target, &[], None, &CancellationToken::new())
            .await
    }

    pub(super) async fn http_json(
        &self,
        target: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, Error> {
        let body = self.http("GET", target, &[], None, cancellation).await?;
        serde_json::from_slice(&body)
            .map_err(|_| Error::local("protocol", Delivery::ResponseReceived))
    }

    async fn http(
        &self,
        method: &str,
        target: &str,
        bytes: &[u8],
        content_type: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, Error> {
        let _operation = self.operation()?;
        let progress = AtomicU8::new(NOT_SENT);
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(Error::local("cancelled", delivery(&progress))),
            _ = self.inner.stopped.cancelled() => Err(Error::local("client_shutdown", delivery(&progress))),
            response = timeout(REQUEST_DEADLINE, self.http_exchange(method, target, bytes, content_type, &progress)) => {
                response.unwrap_or_else(|_| Err(Error::local("deadline", delivery(&progress))))
            },
        };
        result
    }

    async fn http_exchange(
        &self,
        method: &str,
        target: &str,
        bytes: &[u8],
        content_type: Option<&str>,
        progress: &AtomicU8,
    ) -> Result<Vec<u8>, Error> {
        let mut stream = TcpStream::connect(self.inner.address)
            .await
            .map_err(|_| Error::local("connect_failed", Delivery::NotSent))?;
        let token = self.inner.secret.issue_bearer_token();
        if !token.as_str().bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(Error::local("invalid_token", Delivery::NotSent));
        }
        let content_type = content_type
            .map(|value| format!("Content-Type: {value}\r\n"))
            .unwrap_or_default();
        let request = SensitiveHeaders(format!(
            "{method} {target} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n{content_type}Connection: close\r\n\r\n",
            self.inner.address,
            token.as_str(),
            bytes.len(),
        ));
        drop(token);
        progress.store(UNKNOWN, Ordering::Release);
        stream
            .write_all(request.0.as_bytes())
            .await
            .map_err(|_| Error::local("transport", delivery(progress)))?;
        drop(request);
        stream
            .write_all(bytes)
            .await
            .map_err(|_| Error::local("transport", delivery(progress)))?;
        let headers = read_headers(&mut stream)
            .await
            .map_err(|error| error.with_delivery(delivery(progress)))?;
        let response =
            parse_headers(&headers).map_err(|error| error.with_delivery(delivery(progress)))?;
        let body = read_body(&mut stream, response.length)
            .await
            .map_err(|error| error.with_delivery(Delivery::Unknown))?;
        progress.store(RECEIVED, Ordering::Release);
        if (200..300).contains(&response.status) {
            return Ok(body);
        }
        let response: Value = serde_json::from_slice(&body)
            .map_err(|_| Error::local("http_rejected", Delivery::ResponseReceived))?;
        let error = response
            .get("error")
            .and_then(Value::as_object)
            .ok_or_else(|| Error::local("http_rejected", Delivery::ResponseReceived))?;
        let code = error
            .get("code")
            .and_then(Value::as_i64)
            .ok_or_else(|| Error::local("protocol", Delivery::ResponseReceived))?;
        if !error.get("message").is_some_and(Value::is_string) {
            return Err(Error::local("protocol", Delivery::ResponseReceived));
        }
        Err(Error::remote(JsonRpcError::remote(
            code,
            error.get("data").cloned(),
        )))
    }
}

struct Response {
    status: u16,
    length: BodyLength,
}

enum BodyLength {
    Exact(usize),
    Chunked,
    UntilEof,
}

async fn read_headers(stream: &mut TcpStream) -> Result<Vec<u8>, Error> {
    let mut headers = Vec::with_capacity(512);
    while !headers.ends_with(b"\r\n\r\n") {
        if headers.len() == HEADER_LIMIT {
            return Err(Error::local("protocol", Delivery::Unknown));
        }
        headers.push(
            stream
                .read_u8()
                .await
                .map_err(|_| Error::local("transport", Delivery::Unknown))?,
        );
    }
    Ok(headers)
}

fn parse_headers(headers: &[u8]) -> Result<Response, Error> {
    let protocol = || Error::local("protocol", Delivery::Unknown);
    let headers = std::str::from_utf8(headers).map_err(|_| protocol())?;
    let mut lines = headers.split("\r\n");
    let mut status = lines.next().ok_or_else(protocol)?.split_whitespace();
    if !matches!(status.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
        return Err(protocol());
    }
    let status: u16 = status
        .next()
        .ok_or_else(protocol)?
        .parse()
        .map_err(|_| protocol())?;
    let mut content_length = None;
    let mut chunked = false;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or_else(protocol)?;
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(protocol());
            }
            content_length = Some(value.trim().parse::<usize>().map_err(|_| protocol())?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if chunked || !value.trim().eq_ignore_ascii_case("chunked") {
                return Err(protocol());
            }
            chunked = true;
        }
    }
    if chunked && content_length.is_some() {
        return Err(protocol());
    }
    let length = if status == 204 || status == 304 {
        BodyLength::Exact(0)
    } else if chunked {
        BodyLength::Chunked
    } else {
        content_length.map_or(BodyLength::UntilEof, BodyLength::Exact)
    };
    Ok(Response { status, length })
}

async fn read_body(stream: &mut TcpStream, length: BodyLength) -> Result<Vec<u8>, Error> {
    let transport = || Error::local("transport", Delivery::ResponseReceived);
    let mut body = Vec::new();
    match length {
        BodyLength::Exact(length) => {
            // Read incrementally; an untrusted Content-Length must not allocate arbitrary memory upfront.
            let read = (&mut *stream)
                .take(length as u64)
                .read_to_end(&mut body)
                .await
                .map_err(|_| transport())?;
            if read != length {
                return Err(transport());
            }
        }
        BodyLength::UntilEof => {
            stream
                .read_to_end(&mut body)
                .await
                .map_err(|_| transport())?;
        }
        BodyLength::Chunked => loop {
            let line = read_line(stream).await?;
            let size = line.split(|byte| *byte == b';').next().unwrap_or_default();
            let size = std::str::from_utf8(size)
                .ok()
                .and_then(|size| usize::from_str_radix(size, 16).ok())
                .ok_or_else(|| Error::local("protocol", Delivery::ResponseReceived))?;
            if size == 0 {
                let mut trailer_bytes = 0;
                loop {
                    let trailer = read_line(stream).await?;
                    trailer_bytes += trailer.len() + 2;
                    if trailer_bytes > HEADER_LIMIT {
                        return Err(Error::local("protocol", Delivery::ResponseReceived));
                    }
                    if trailer.is_empty() {
                        break;
                    }
                }
                break;
            }
            let start = body.len();
            (&mut *stream)
                .take(size as u64)
                .read_to_end(&mut body)
                .await
                .map_err(|_| transport())?;
            if body.len() - start != size {
                return Err(transport());
            }
            if stream.read_u16().await.map_err(|_| transport())? != 0x0d0a {
                return Err(Error::local("protocol", Delivery::ResponseReceived));
            }
        },
    }
    Ok(body)
}

async fn read_line(stream: &mut TcpStream) -> Result<Vec<u8>, Error> {
    let mut line = Vec::new();
    while !line.ends_with(b"\r\n") {
        if line.len() == HEADER_LIMIT {
            return Err(Error::local("protocol", Delivery::ResponseReceived));
        }
        line.push(
            stream
                .read_u8()
                .await
                .map_err(|_| Error::local("transport", Delivery::ResponseReceived))?,
        );
    }
    line.truncate(line.len() - 2);
    Ok(line)
}

fn delivery(progress: &AtomicU8) -> Delivery {
    match progress.load(Ordering::Acquire) {
        NOT_SENT => Delivery::NotSent,
        RECEIVED => Delivery::ResponseReceived,
        _ => Delivery::Unknown,
    }
}

fn file_target(agent_id: &str, path: &str) -> Result<String, Error> {
    let agent = segment(agent_id)?;
    if path.is_empty() {
        return Err(Error::local("invalid_params", Delivery::NotSent));
    }
    let path: Vec<_> = path.split('/').map(segment).collect::<Result<_, _>>()?;
    Ok(format!("/files/{agent}/{}", path.join("/")))
}

fn segment(value: &str) -> Result<String, Error> {
    if value.is_empty() || matches!(value, "." | "..") || value.contains(['/', '\\', '\0']) {
        return Err(Error::local("invalid_params", Delivery::NotSent));
    }
    Ok(encode(value))
}

fn encode(value: &str) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

struct SensitiveHeaders(String);

impl Drop for SensitiveHeaders {
    fn drop(&mut self) {
        // SAFETY: replacing every byte with NUL preserves valid UTF-8.
        for byte in unsafe { self.0.as_mut_vec() } {
            // SAFETY: byte is uniquely borrowed from this allocation.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}
