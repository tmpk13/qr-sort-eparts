//! Linker setup for the RP2040.
//!
//! cortex-m-rt's link.x does `INCLUDE memory.x`, so memory.x is copied into the
//! build output directory and that directory is put on the linker search path.
//! embassy-rp's link-rp.x places the second-stage bootloader in .boot2.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::write(out.join("memory.x"), include_bytes!("memory.x")).unwrap();
    println!("cargo:rustc-link-search={}", out.display());
    println!("cargo:rerun-if-changed=memory.x");
    println!("cargo:rerun-if-changed=build.rs");

    // Only the firmware binary links for the board; a host test of the
    // library must not see these scripts.
    if env::var("TARGET").unwrap_or_default().starts_with("thumb") {
        println!("cargo:rustc-link-arg-bins=--nmagic");
        println!("cargo:rustc-link-arg-bins=-Tlink.x");
        println!("cargo:rustc-link-arg-bins=-Tlink-rp.x");
        println!("cargo:rustc-link-arg-bins=-Tdefmt.x");
    }
}
