use std::{env, fs, path::PathBuf};

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").unwrap() != "windows" {
        return;
    }
    let architecture = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "x86_64" => "x86_64",
        "x86" => "i686",
        "aarch64" => "arm64",
        architecture => panic!("Unsupported Windows architecture: {architecture}"),
    };
    let library = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../build/network-source/easytier/easytier/third_party")
        .join(architecture)
        .canonicalize()
        .expect("Prepare the pinned EasyTier sources before building");
    println!("cargo:rustc-link-search=native={}", library.display());
    println!("cargo:rerun-if-changed={}", library.display());
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let profile = output.ancestors().nth(3).unwrap();
    fs::copy(library.join("Packet.dll"), profile.join("Packet.dll"))
        .expect("Stage the pinned Packet runtime beside matcha-network");
}
