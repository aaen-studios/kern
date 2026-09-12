//! Output formatting: format/color selection, tables, badges, sparklines.

use std::io::IsTerminal;

use clap::ValueEnum;

/// `--format` for human vs machine output.
#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum Format {
    /// Aligned tables with color (default).
    Table,
    /// One record per line, tab-separated, no headers.
    Plain,
    /// Raw JSON (or NDJSON for streaming commands).
    Json,
}

/// `--color` handling.
#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum ColorWhen {
    Auto,
    Always,
    Never,
}

/// Shared output preferences resolved once from CLI flags + environment.
#[derive(Clone)]
pub struct Output {
    pub format: Format,
    pub color: bool,
    pub quiet: bool,
}

impl Output {
    pub fn new(format: Format, color: ColorWhen, quiet: bool) -> Self {
        let color = match color {
            ColorWhen::Always => true,
            ColorWhen::Never => false,
            ColorWhen::Auto => {
                std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal()
            }
        };
        // Machine formats never carry escapes.
        let color = color && format != Format::Json;
        Output {
            format,
            color,
            quiet,
        }
    }

    pub fn paint(&self, code: &str, text: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    }

    pub fn green(&self, text: &str) -> String {
        self.paint("32", text)
    }

    pub fn red(&self, text: &str) -> String {
        self.paint("31", text)
    }

    pub fn amber(&self, text: &str) -> String {
        self.paint("33", text)
    }

    pub fn dim(&self, text: &str) -> String {
        self.paint("2", text)
    }

    pub fn bold(&self, text: &str) -> String {
        self.paint("1", text)
    }

    /// Colored status label for the table view.
    pub fn status_badge(&self, status: &str, running: bool) -> String {
        let label = if status.is_empty() {
            if running {
                "running"
            } else {
                "stopped"
            }
        } else {
            status
        };
        match label {
            "running" => self.green(label),
            "starting" | "stopping" | "restarting" => self.amber(label),
            "error" | "stopped-forced" => self.red(label),
            _ => self.dim(label),
        }
    }

    /// Prints a table; when color is on, cells may contain ANSI codes but
    /// `widths` are computed from the pre-colored text passed by the caller.
    pub fn table(&self, headers: &[&str], rows: &[Vec<String>]) {
        let cols = headers.len();
        let mut widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();
        for row in rows {
            for (i, cell) in row.iter().enumerate().take(cols) {
                widths[i] = widths[i].max(visible_len(cell));
            }
        }
        let header = headers
            .iter()
            .enumerate()
            .map(|(i, h)| pad_visible(h, widths[i]))
            .collect::<Vec<_>>()
            .join("  ");
        println!("{}", self.dim(&header));
        for row in rows {
            let line = row
                .iter()
                .enumerate()
                .take(cols)
                .map(|(i, cell)| pad_visible(cell, widths[i]))
                .collect::<Vec<_>>()
                .join("  ");
            println!("{line}");
        }
    }

    pub fn key_values(&self, pairs: &[(&str, String)]) {
        let width = pairs.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
        for (key, value) in pairs {
            println!("{}  {}", self.dim(&format!("{key:<width$}")), value);
        }
    }
}

/// Visible length ignoring ANSI escapes.
pub fn visible_len(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut len = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            i += 2;
            while i < bytes.len() && !bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            i += 1; // skip the terminator
        } else {
            len += 1;
            i += 1;
        }
    }
    len
}

/// Pads to `width` based on visible length (ANSI-safe).
pub fn pad_visible(text: &str, width: usize) -> String {
    let len = visible_len(text);
    if len >= width {
        text.to_string()
    } else {
        format!("{text}{}", " ".repeat(width - len))
    }
}

/// `12%` / `-`.
pub fn fmt_pct(value: Option<f32>) -> String {
    match value {
        Some(v) => format!("{:.0}%", v * 100.0),
        None => "-".to_string(),
    }
}

/// `2h 14m`, `43s`, `3d 2h`.
pub fn fmt_uptime(secs: Option<u64>) -> String {
    let Some(secs) = secs else {
        return "-".to_string();
    };
    let days = secs / 86_400;
    let hours = (secs % 86_400) / 3_600;
    let mins = (secs % 3_600) / 60;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {mins}m")
    } else if mins > 0 {
        format!("{mins}m {}s", secs % 60)
    } else {
        format!("{secs}s")
    }
}

/// Epoch seconds → local `HH:MM:SS` (falls back to the raw number).
pub fn fmt_time(epoch: u64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_opt(epoch as i64, 0)
        .single()
        .map(|t| t.format("%H:%M:%S").to_string())
        .unwrap_or_else(|| epoch.to_string())
}

/// `▁▂▃▄▅▆▇█` sparkline from 0..1 samples.
pub fn sparkline(samples: &[f32]) -> String {
    const BLOCKS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    if samples.is_empty() {
        return String::new();
    }
    samples
        .iter()
        .map(|v| {
            let idx = (v.clamp(0.0, 1.0) * (BLOCKS.len() - 1) as f32).round() as usize;
            BLOCKS[idx]
        })
        .collect()
}

/// Parses `30s`, `5m`, `2h`, or a bare number of seconds.
pub fn parse_duration(text: &str) -> Result<std::time::Duration, String> {
    let text = text.trim();
    let (num, unit) = match text.chars().last() {
        Some(last) if last.is_ascii_alphabetic() => (&text[..text.len() - 1], last),
        Some(_) => (text, 's'),
        None => return Err("empty duration".into()),
    };
    let multiplier = match unit {
        's' => 1.0,
        'm' => 60.0,
        'h' => 3600.0,
        other => return Err(format!("unknown duration unit '{other}' (use s/m/h)")),
    };
    let value: f64 = num
        .parse()
        .map_err(|_| format!("invalid duration '{text}'"))?;
    Ok(std::time::Duration::from_secs_f64(value * multiplier))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_len_ignores_ansi() {
        assert_eq!(visible_len("\x1b[32mrunning\x1b[0m"), 7);
        assert_eq!(visible_len("plain"), 5);
    }

    #[test]
    fn pad_visible_pads_after_ansi() {
        assert_eq!(pad_visible("\x1b[32mok\x1b[0m", 4), "\x1b[32mok\x1b[0m  ");
    }

    #[test]
    fn uptime_formatting() {
        assert_eq!(fmt_uptime(Some(12)), "12s");
        assert_eq!(fmt_uptime(Some(125)), "2m 5s");
        assert_eq!(fmt_uptime(Some(7_500)), "2h 5m");
        assert_eq!(fmt_uptime(Some(200_000)), "2d 7h");
        assert_eq!(fmt_uptime(None), "-");
    }

    #[test]
    fn duration_parsing() {
        assert_eq!(parse_duration("30").unwrap().as_secs(), 30);
        assert_eq!(parse_duration("30s").unwrap().as_secs(), 30);
        assert_eq!(parse_duration("5m").unwrap().as_secs(), 300);
        assert_eq!(parse_duration("2h").unwrap().as_secs(), 7200);
        assert!(parse_duration("5x").is_err());
        assert!(parse_duration("").is_err());
    }

    #[test]
    fn sparkline_maps_range() {
        assert_eq!(sparkline(&[0.0, 0.5, 1.0]), "▁▅█");
    }
}
