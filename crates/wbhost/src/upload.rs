//! File uploads for import (BUILD-SPEC §5.2, PRD E32): the browser POSTs the file
//! straight to the workbook host under a client-generated import id, optionally
//! gzip-compressed. It is staged as `{workbook}/staging/{import_id}.{name}`, already
//! decompressed (spike S3 finding 2), and later read by `ImportPreview` /
//! `FinalizeImport` on the sheet channel. URL imports fetch into the same place.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

/// Self-serve plan limit (PRD FR-16).
pub const MAX_UPLOAD_BYTES: u64 = 5 << 30;
/// Uploads that are never imported are swept after this long (BUILD-SPEC §9).
const STAGING_TTL: Duration = Duration::from_secs(24 * 3600);

#[derive(Debug)]
pub enum UploadError {
    Bad(String),
    TooLarge,
    Io(std::io::Error),
}

impl From<std::io::Error> for UploadError {
    fn from(e: std::io::Error) -> Self {
        UploadError::Io(e)
    }
}

pub fn valid_import_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A safe file name keeping the extension; `.gz` is dropped because staged files are
/// stored decompressed.
pub fn clean_name(name: &str) -> Result<(String, bool), UploadError> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' ' | '(' | ')'))
        .collect();
    let gz = cleaned.to_ascii_lowercase().ends_with(".gz");
    if gz {
        cleaned.truncate(cleaned.len() - 3);
    }
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.len() > 120 || importer::Format::from_name(&cleaned).is_none() {
        return Err(UploadError::Bad(
            "unsupported file type: use CSV, TSV, TXT, JSONL, Parquet or XLSX (optionally .gz)"
                .into(),
        ));
    }
    Ok((cleaned, gz))
}

fn sweep(staging: &Path) {
    let Ok(entries) = std::fs::read_dir(staging) else {
        return;
    };
    let now = SystemTime::now();
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > STAGING_TTL);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Stream `body` into the workbook's staging directory; returns (name, bytes staged).
pub async fn stage<S, E>(
    workbook_dir: PathBuf,
    import_id: &str,
    name: &str,
    gzip_header: bool,
    mut body: S,
) -> Result<(String, u64), UploadError>
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    if !valid_import_id(import_id) {
        return Err(UploadError::Bad("invalid import id".into()));
    }
    let (name, gz_name) = clean_name(name)?;
    let staging = workbook_dir.join("staging");
    tokio::fs::create_dir_all(&staging).await?;
    let sweep_dir = staging.clone();
    tokio::task::spawn_blocking(move || sweep(&sweep_dir));

    let part = staging.join(format!("{import_id}.{name}.part"));
    let mut file = tokio::fs::File::create(&part).await?;
    let mut written: u64 = 0;
    let mut head = [0u8; 2];
    while let Some(chunk) = body.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(UploadError::Bad(format!("upload interrupted: {e}")));
            }
        };
        if written < 2 {
            for (i, b) in chunk.iter().take(2 - written as usize).enumerate() {
                head[written as usize + i] = *b;
            }
        }
        written += chunk.len() as u64;
        if written > MAX_UPLOAD_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(UploadError::TooLarge);
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);

    let target = staging.join(format!("{import_id}.{name}"));
    let gzip = gzip_header || gz_name || head == [0x1f, 0x8b];
    let size = tokio::task::spawn_blocking(move || -> Result<u64, UploadError> {
        if gzip {
            let input = std::io::BufReader::with_capacity(1 << 20, std::fs::File::open(&part)?);
            let mut decoder = flate2::read::MultiGzDecoder::new(input);
            let tmp = target.with_extension("unzipping");
            let mut out = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(&tmp)?);
            let n = std::io::copy(&mut decoder, &mut out)
                .map_err(|e| UploadError::Bad(format!("not valid gzip: {e}")))?;
            drop(out);
            std::fs::remove_file(&part)?;
            std::fs::rename(&tmp, &target)?;
            Ok(n)
        } else {
            std::fs::rename(&part, &target)?;
            Ok(std::fs::metadata(&target)?.len())
        }
    })
    .await
    .map_err(|e| UploadError::Bad(e.to_string()))??;
    Ok((name, size))
}

/// Whether an address is on the public internet (SSRF guard for URL imports).
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1]))
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80)
        }
    }
}

/// Fetch `url` into staging. Only http(s) to public addresses unless `allow_private`;
/// the connection is pinned to the checked address so DNS cannot be swapped under us.
pub async fn fetch(
    workbook_dir: PathBuf,
    import_id: &str,
    url: &str,
    allow_private: bool,
) -> Result<(String, u64), UploadError> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| UploadError::Bad("not a valid URL".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(UploadError::Bad(
            "only http and https URLs can be imported".into(),
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| UploadError::Bad("the URL has no host".into()))?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| UploadError::Bad(format!("could not resolve {host}")))?
        .collect();
    let addr = *addrs
        .first()
        .ok_or_else(|| UploadError::Bad(format!("could not resolve {host}")))?;
    if !allow_private && addrs.iter().any(|a| !is_public(a.ip())) {
        return Err(UploadError::Bad(
            "that address is not on the public internet".into(),
        ));
    }
    let client = reqwest::Client::builder()
        .resolve(&host, addr)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| UploadError::Bad(e.to_string()))?;
    let resp = client
        .get(parsed.clone())
        .send()
        .await
        .map_err(|e| UploadError::Bad(format!("download failed: {e}")))?;
    if resp.status().is_redirection() {
        let to = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("another address");
        return Err(UploadError::Bad(format!(
            "the URL redirects to {to}; import that URL instead"
        )));
    }
    if !resp.status().is_success() {
        return Err(UploadError::Bad(format!(
            "download failed: HTTP {}",
            resp.status()
        )));
    }
    if resp.content_length().is_some_and(|n| n > MAX_UPLOAD_BYTES) {
        return Err(UploadError::TooLarge);
    }
    let gzip_header = resp
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("gzip"));
    let name = parsed
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|s| !s.is_empty())
        .unwrap_or("download.csv")
        .to_string();
    let name = if importer::Format::from_name(name.trim_end_matches(".gz")).is_some() {
        name
    } else {
        format!("{name}.csv")
    };
    stage(
        workbook_dir,
        import_id,
        &name,
        gzip_header,
        resp.bytes_stream(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_addresses() {
        assert_eq!(
            clean_name("../x/Orders 2025.csv.gz").unwrap(),
            ("Orders 2025.csv".into(), true)
        );
        assert!(clean_name("evil.exe").is_err());
        assert!(!valid_import_id("../a"));
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fd00::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        assert!(is_public("8.8.8.8".parse().unwrap()));
        assert!(is_public("2606:4700::1111".parse().unwrap()));
    }

    #[tokio::test]
    async fn stages_plain_and_gzip_uploads() {
        let dir = tempfile::tempdir().unwrap();
        let body = |b: Vec<u8>| {
            futures_util::stream::iter(vec![Ok::<_, std::io::Error>(bytes::Bytes::from(b))])
        };
        let (name, n) = stage(
            dir.path().into(),
            "u1",
            "a.csv",
            false,
            body(b"x,y\n1,2\n".to_vec()),
        )
        .await
        .unwrap();
        assert_eq!((name.as_str(), n), ("a.csv", 8));
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, b"x,y\n3,4\n").unwrap();
        let (name, n) = stage(
            dir.path().into(),
            "u2",
            "b.csv",
            false,
            body(gz.finish().unwrap()),
        )
        .await
        .unwrap();
        assert_eq!((name.as_str(), n), ("b.csv", 8));
        assert_eq!(
            std::fs::read(dir.path().join("staging/u2.b.csv")).unwrap(),
            b"x,y\n3,4\n"
        );
    }
}
