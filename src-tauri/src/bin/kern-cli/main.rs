//! kern-cli — scriptable control for a running kern app.
//!
//! Talks to the loopback automation API (`127.0.0.1`, Bearer token published
//! in `<app_data>/automation.json`). Console-first: human-readable by default,
//! `--format json` for scripting, `--format plain` for tab-separated output.
//!
//! Exit codes: 0 ok · 1 error · 2 usage · 3 not found · 4 app unreachable ·
//! 5 timeout.
//!
//! Bare invocation on a terminal opens the interactive dashboard.

mod client;
mod commands;
mod output;
mod tui;

use std::io::IsTerminal;
use std::process::ExitCode;

use clap::{CommandFactory, Parser, Subcommand};

use crate::client::{CliError, Client, EXIT_USAGE};
use crate::output::{ColorWhen, Format, Output};

#[derive(Debug, Parser)]
#[command(
    name = "kern-cli",
    version,
    about = "control a running kern app",
    disable_help_subcommand = true
)]
struct Cli {
    /// Output format.
    #[arg(long, global = true, value_enum, default_value_t = Format::Table)]
    format: Format,
    /// Color output.
    #[arg(long, global = true, value_enum, default_value_t = ColorWhen::Auto)]
    color: ColorWhen,
    /// Suppress informational output.
    #[arg(short, long, global = true)]
    quiet: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Show app + host status.
    Status,
    /// List registered servers.
    List(commands::ListArgs),
    /// Show one server in detail.
    Show {
        /// Server id or name.
        server: String,
    },
    /// Register a folder as a server instance.
    Add(commands::AddArgs),
    /// Inspect a folder before importing it.
    Inspect {
        /// Folder to inspect.
        path: String,
    },
    /// Update an existing server's name/group/tags/auto-start.
    Edit(commands::EditArgs),
    /// Remove a server record (optionally its folder).
    Rm(commands::RmArgs),
    /// Start one or more servers.
    Start(commands::ActionArgs),
    /// Stop one or more servers.
    Stop(commands::ActionArgs),
    /// Restart one or more servers.
    Restart(commands::ActionArgs),
    /// Run the install lifecycle step.
    Install(commands::ActionArgs),
    /// Block until a server reaches a state.
    Wait(commands::WaitArgs),
    /// Stream an instance's log.
    Logs(commands::LogsArgs),
    /// Write a line to an instance's stdin.
    #[command(visible_alias = "say")]
    Send(commands::SendArgs),
    /// Live fleet overview (one snapshot with --once).
    Top(commands::TopArgs),
    /// Host telemetry.
    Host,
    /// Instance metric history.
    Metrics(commands::MetricsArgs),
    /// Energy / cost estimate.
    Energy {
        /// Server id or name.
        server: String,
    },
    /// Listening ports with quick-connect strings.
    Port {
        /// Server id or name.
        server: String,
    },
    /// Pre-start checks (ports, eula, disk).
    Preflight {
        /// Server id or name.
        server: String,
    },
    /// Last crash report.
    Crash {
        /// Server id or name.
        server: String,
    },
    /// World snapshots.
    Backup {
        #[command(subcommand)]
        cmd: commands::BackupCmd,
    },
    /// Scheduled tasks.
    Task {
        #[command(subcommand)]
        cmd: commands::TaskCmd,
    },
    /// Stream audit + lifecycle events.
    Events(commands::EventsArgs),
    /// Show the audit log.
    Audit(commands::AuditArgs),
    /// Installed plugins.
    Plugin {
        #[command(subcommand)]
        cmd: commands::PluginCmd,
    },
    /// Send a raw request to the automation API.
    Api(commands::ApiArgs),
    /// Diagnose endpoint / version / connectivity problems.
    Doctor,
    /// Print the automation endpoint.
    Endpoint(commands::EndpointArgs),
    /// Generate shell completions.
    Completions {
        #[arg(value_enum)]
        shell: clap_complete::Shell,
    },
    /// Open the interactive dashboard.
    Dash,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let out = Output::new(cli.format, cli.color, cli.quiet);

    let result = match &cli.command {
        None => {
            if std::io::stdout().is_terminal() {
                tui::run(&out)
            } else {
                let mut cmd = Cli::command();
                let _ = cmd.print_help();
                Ok(())
            }
        }
        Some(Command::Dash) => tui::run(&out),
        Some(command) => run(command, &out),
    };

    match result {
        Ok(()) => ExitCode::from(client::EXIT_OK),
        Err(e) => {
            eprintln!("kern-cli: {e}");
            ExitCode::from(e.exit_code())
        }
    }
}

fn run(command: &Command, out: &Output) -> Result<(), CliError> {
    // Commands that never touch the API.
    if let Command::Completions { shell } = command {
        let mut cmd = Cli::command();
        clap_complete::generate(*shell, &mut cmd, "kern-cli", &mut std::io::stdout());
        return Ok(());
    }
    // doctor diagnoses discovery itself, so it must run even when the app is
    // unreachable (that's usually the reason you're running it).
    if let Command::Doctor = command {
        return commands::doctor(out);
    }

    let client = Client::discover()?;
    deliver(command, out, &client)
}

fn deliver(command: &Command, out: &Output, client: &Client) -> Result<(), CliError> {
    match command {
        Command::Status => commands::status(client, out),
        Command::List(args) => commands::list(client, out, args),
        Command::Show { server } => commands::show(client, out, server),
        Command::Add(args) => commands::add(client, out, args),
        Command::Inspect { path } => commands::inspect(client, out, path),
        Command::Edit(args) => commands::edit(client, out, args),
        Command::Rm(args) => commands::remove(client, out, args),
        Command::Start(args) => commands::action(client, out, "start", args),
        Command::Stop(args) => commands::action(client, out, "stop", args),
        Command::Restart(args) => commands::action(client, out, "restart", args),
        Command::Install(args) => commands::action(client, out, "install", args),
        Command::Wait(args) => commands::wait(client, out, args),
        Command::Logs(args) => commands::logs(client, out, args),
        Command::Send(args) => commands::send(client, out, args),
        Command::Top(args) => commands::top(client, out, args),
        Command::Host => commands::host(client, out),
        Command::Metrics(args) => commands::metrics(client, out, args),
        Command::Energy { server } => commands::energy(client, out, server),
        Command::Port { server } => commands::port(client, out, server),
        Command::Preflight { server } => commands::preflight(client, out, server),
        Command::Crash { server } => commands::crash(client, out, server),
        Command::Backup { cmd } => commands::backup(client, out, cmd),
        Command::Task { cmd } => commands::task(client, out, cmd),
        Command::Events(args) => commands::events(client, out, args),
        Command::Audit(args) => commands::audit(client, out, args),
        Command::Plugin { cmd } => commands::plugin(client, out, cmd),
        Command::Api(args) => commands::api(client, out, args),
        Command::Doctor => unreachable!("handled in run"),
        Command::Endpoint(args) => commands::endpoint(client, out, args),
        Command::Completions { .. } => {
            let mut cmd = Cli::command();
            let _ = cmd.print_help();
            Err(CliError::Error(format!("usage error ({EXIT_USAGE})")))
        }
        Command::Dash => unreachable!("handled in main"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_global_flags_before_and_after_subcommand() {
        let cli = Cli::try_parse_from(["kern-cli", "--format", "json", "list"]).unwrap();
        assert_eq!(cli.format, Format::Json);
        assert!(matches!(cli.command, Some(Command::List(_))));

        let cli = Cli::try_parse_from(["kern-cli", "list", "--format", "plain"]).unwrap();
        assert_eq!(cli.format, Format::Plain);
    }

    #[test]
    fn fleet_flags_parse() {
        let cli = Cli::try_parse_from([
            "kern-cli", "stop", "--tag", "prod", "--wait", "--timeout", "2m",
        ])
        .unwrap();
        match cli.command {
            Some(Command::Stop(args)) => {
                assert_eq!(args.tag.as_deref(), Some("prod"));
                assert!(args.wait);
                assert_eq!(args.timeout, "2m");
            }
            other => panic!("expected stop, got {other:?}"),
        }
    }

    #[test]
    fn say_is_an_alias_for_send() {
        let cli = Cli::try_parse_from(["kern-cli", "say", "mc", "hello", "world"]).unwrap();
        match cli.command {
            Some(Command::Send(args)) => {
                assert_eq!(args.server, "mc");
                assert_eq!(args.message, vec!["hello", "world"]);
            }
            other => panic!("expected send, got {other:?}"),
        }
    }

    #[test]
    fn unknown_subcommand_is_a_usage_error() {
        let err = Cli::try_parse_from(["kern-cli", "frobnicate"]).unwrap_err();
        // clap marks parse failures as exit code 2.
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn completions_accept_known_shells() {
        let cli = Cli::try_parse_from(["kern-cli", "completions", "bash"]).unwrap();
        match cli.command {
            Some(Command::Completions { shell }) => {
                assert_eq!(shell, clap_complete::Shell::Bash);
            }
            other => panic!("expected completions, got {other:?}"),
        }
    }
}
