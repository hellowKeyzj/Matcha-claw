use std::time::Duration;

use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};

use super::read_request;

#[tokio::test]
async fn reads_exact_empty_body_across_tcp_reads() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind listener");
    let port = listener.local_addr().expect("listener address").port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept connection");
        let request = read_request(&mut stream).await.expect("read request");
        match request {
            Ok(request) => serde_json::to_value(request.body).expect("serialize body"),
            Err(_) => Value::Null,
        }
    });

    let mut client = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect client");
    client
        .write_all(b"POST /api/security/emergency HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n")
        .await
        .expect("write headers");
    tokio::time::sleep(Duration::from_millis(1)).await;
    client.write_all(b"{}").await.expect("write body");
    drop(client);

    assert_eq!(server.await.expect("server task"), json!([123, 125]));
}

#[tokio::test]
async fn rejects_non_empty_request_bodies_before_json_decoding() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind listener");
    let port = listener.local_addr().expect("listener address").port();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept connection");
        read_request(&mut stream)
            .await
            .expect("read request")
            .is_err()
    });

    let mut client = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect client");
    client
        .write_all(b"POST /api/security/emergency HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 16\r\n\r\n{\"target\":\"all\"}")
        .await
        .expect("write request");
    drop(client);

    assert!(server.await.expect("server task"));
}
