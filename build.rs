fn main() {
    // The web UI is embedded from web/dist; make sure the folder exists so a
    // backend-only build works (it then serves a hint to build the UI).
    let _ = std::fs::create_dir_all("web/dist");
    println!("cargo:rerun-if-changed=web/dist");
}
