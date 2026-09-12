//! Dev utility for the web-remote token in the OS credential vault.
//!
//! Usage:
//!   cargo run --example web_token          # print the token
//!   cargo run --example web_token -- set X # store X (debug)
//!   cargo run --example web_token -- delete
//!   cargo run --example web_token -- selftest

fn entry() -> keyring::Entry {
    keyring::Entry::new("kern.webremote", "token").expect("keyring entry")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let e = entry();
    match args.get(1).map(String::as_str) {
        Some("set") => {
            e.set_password(args.get(2).expect("value")).expect("set");
            println!("stored");
        }
        Some("delete") => {
            let _ = e.delete_credential();
            println!("deleted");
        }
        Some("selftest") => {
            e.set_password("selftest-value").expect("set");
            println!("read back: {:?}", e.get_password());
        }
        _ => match e.get_password() {
            Ok(token) => println!("{token}"),
            Err(err) => {
                eprintln!("failed to read web-remote token: {err}");
                std::process::exit(1);
            }
        },
    }
}
