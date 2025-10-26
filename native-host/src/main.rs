use std::collections::{HashMap, VecDeque};
use std::env;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::mem;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use clap::Parser;
use crossbeam_channel::{Receiver, Sender, bounded, unbounded};
use regex::Regex;
use serde::{Deserialize, Serialize};
use shared_child::SharedChild;
use uuid::Uuid;

const MAX_CONCURRENT_JOBS: usize = 5;
const PROCESS_LOG_LIMIT_BYTES: usize = 64 * 1024;
const FFMPEG_MERGE_TIMEOUT_SECS: u64 = 10 * 60;

/// コマンドライン引数を表す構造体。
#[derive(Debug, Parser)]
#[command(
    author,
    version,
    about = "WidevineProxy2 Native Host",
    disable_help_subcommand = true
)]
struct Cli {
    /// 自己診断モードを有効にします。
    #[arg(long, help = "依存バイナリと環境を確認するセルフテストを実行します。")]
    self_test: bool,
    /// Chrome から渡される呼び出し元オリジン（未使用だが clap で受け取っておく）。
    #[arg(value_name = "CALLER_ORIGIN", hide = true)]
    caller_origin: Option<String>,
    /// Windows などで付与される parent-window 引数（未使用）。
    #[arg(long = "parent-window", hide = true)]
    parent_window: Option<String>,
}

/// キー情報を表すペイロード。
#[derive(Debug, Deserialize, Serialize, Clone)]
struct KeyEntry {
    kid: String,
    key: String,
}

/// ダウンロード要求のメッセージ形式。
#[derive(Debug, Deserialize, Serialize)]
struct DownloadRequest {
    #[serde(rename = "mpdUrl")]
    mpd_url: Option<String>,
    #[serde(rename = "sourceUrl")]
    source_url: Option<String>,
    #[serde(default)]
    keys: Vec<KeyEntry>,
    #[serde(default)]
    kind: Option<String>,
    metadata: Option<serde_json::Value>,
    #[serde(rename = "outputTemplate")]
    output_template: Option<String>,
    #[serde(rename = "clientJobId")]
    client_job_id: Option<String>,
    #[serde(rename = "outputDir")]
    output_dir: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(rename = "jobId")]
    job_id: Option<String>,
}

/// メタデータの細分化。
#[derive(Debug, Deserialize, Serialize, Default, Clone)]
struct MetadataPayload {
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(rename = "type")]
    manifest_type: Option<String>,
    #[serde(rename = "manifestUrl")]
    manifest_url: Option<String>,
    #[serde(rename = "sourceUrl")]
    source_url: Option<String>,
    #[serde(rename = "capturedAt")]
    captured_at: Option<u64>,
    #[serde(rename = "outputSlug")]
    output_slug: Option<String>,
    #[serde(default)]
    cookies: CookieMetadata,
    #[serde(rename = "transport", default)]
    transport: Option<TransportMetadata>,
}

impl MetadataPayload {
    /// 暗号化方式から鍵が必要かどうかを判定します。
    fn requires_key_material(&self) -> bool {
        let encryption = self
            .transport
            .as_ref()
            .and_then(|transport| transport.encryption.as_ref())
            .map(|value| value.to_ascii_lowercase());
        match encryption.as_deref() {
            Some("clear") | Some("none") => false,
            _ => true,
        }
    }
}

/// 配送方式に関するメタ情報。
#[derive(Debug, Deserialize, Serialize, Default, Clone)]
struct TransportMetadata {
    #[serde(rename = "manifestType")]
    manifest_type: Option<String>,
    #[serde(rename = "drmType")]
    drm_type: Option<String>,
    #[serde(rename = "encryption")]
    encryption: Option<String>,
    #[serde(rename = "segmentFormat")]
    segment_format: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

/// Cookie 設定を表す構造体。
#[derive(Debug, Deserialize, Serialize, Default, Clone)]
struct CookieMetadata {
    #[serde(default)]
    strategy: Option<String>,
    #[serde(default)]
    profile: Option<String>,
}

/// レスポンスの共通フォーマット。
#[derive(Debug, Deserialize, Serialize)]
struct HostResponse {
    status: ResponseStatus,
    #[serde(rename = "jobId")]
    job_id: Option<String>,
    #[serde(rename = "clientJobId")]
    client_job_id: Option<String>,
    message: String,
}

/// レスポンスステータスを列挙。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ResponseStatus {
    Accepted,
    Error,
    Pong,
}

/// ネイティブポートへの書き込みを直列化する仕組み。
#[derive(Clone)]
struct MessageWriter {
    tx: Sender<Vec<u8>>,
}

impl MessageWriter {
    fn new() -> Self {
        let (tx, rx) = unbounded::<Vec<u8>>();
        thread::spawn(move || {
            let stdout = io::stdout();
            let mut handle = stdout.lock();
            while let Ok(bytes) = rx.recv() {
                let len = bytes.len() as u32;
                if handle.write_all(&len.to_le_bytes()).is_err() {
                    break;
                }
                if handle.write_all(&bytes).is_err() {
                    break;
                }
                if handle.flush().is_err() {
                    break;
                }
            }
        });
        Self { tx }
    }

    fn send<T>(&self, value: &T) -> Result<()>
    where
        T: Serialize,
    {
        let bytes = serde_json::to_vec(value).context("イベントのシリアライズに失敗しました")?;
        self.tx
            .send(bytes)
            .map_err(|err| anyhow!("ホストへの書き込みに失敗しました: {err}"))
    }
}

fn main() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log_event(format!("panic: {info}"));
        default_hook(info);
    }));

    if let Err(error) = run() {
        log_event(format!("host error: {error:?}"));
        eprintln!("native-host error: {error:?}");
        process::exit(1);
    }
}

/// エントリーポイントのロジックを実行します。
fn run() -> Result<()> {
    log_event("host started");
    let cli = Cli::parse();
    log_event(format!(
        "cli parsed: self_test={}, caller_origin={:?}, parent_window={:?}",
        cli.self_test, cli.caller_origin, cli.parent_window
    ));

    if cli.self_test {
        run_self_test()?;
        return Ok(());
    }

    let config = HostConfig::detect()?;
    emit_binary_resolution_log(&config);
    let writer = MessageWriter::new();
    let job_manager = JobManager::new(config, writer.clone());
    log_event("listening for native messages");
    listen_for_messages(writer, job_manager)?;
    log_event("host exiting normally");
    Ok(())
}

/// ネイティブホストが検出した依存バイナリの絶対パスをログへ記録します。
fn emit_binary_resolution_log(config: &HostConfig) {
    let summary = format!(
        "resolved binaries: yt-dlp={}, mp4decrypt={}, ffmpeg={}",
        config.yt_dlp.display(),
        config.mp4decrypt.display(),
        config.ffmpeg.display()
    );
    log_event(&summary);
    eprintln!("[info] {summary}");
}

/// 依存バイナリの存在確認と動作チェックを行います。
fn run_self_test() -> Result<()> {
    let required_bins = ["yt-dlp", "mp4decrypt", "ffmpeg"];
    for bin in required_bins {
        match which::which(bin) {
            Ok(path) => {
                println!("✔ {bin} -> {}", path.display());
            }
            Err(err) => {
                println!("✖ {bin} が見つかりません: {err}");
            }
        }
    }
    println!("ネイティブメッセージング JSON I/O の基本テストを実行します...");
    let ping = HostResponse {
        status: ResponseStatus::Pong,
        job_id: None,
        client_job_id: None,
        message: "pong".to_string(),
    };
    write_message(&ping)?;
    Ok(())
}

/// 標準入力からメッセージを受け取り、処理結果を書き戻します。
fn listen_for_messages(writer: MessageWriter, job_manager: JobManager) -> Result<()> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();

    loop {
        let mut length_buf = [0u8; 4];
        match reader.read_exact(&mut length_buf) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(err) => {
                log_event(&format!("failed to read length: {err}"));
                return Err(err).context("メッセージ長の読み取りに失敗しました");
            }
        }

        let length = u32::from_le_bytes(length_buf) as usize;
        let mut payload = vec![0u8; length];
        reader
            .read_exact(&mut payload)
            .context("メッセージ本体の読み取りに失敗しました")?;
        log_event(&format!("received payload ({} bytes)", length));

        let request: DownloadRequest =
            serde_json::from_slice(&payload).context("JSON ペイロードのパースに失敗しました")?;
        let response = handle_download_request(request, &job_manager)?;
        writer.send(&response)?;
        log_event("sent response");
    }

    Ok(())
}

/// ダウンロード要求を検証し、ジョブ ID を割り当てます。
fn handle_download_request(
    mut request: DownloadRequest,
    job_manager: &JobManager,
) -> Result<HostResponse> {
    if matches!(request.kind.as_deref(), Some("ping")) {
        log_event("received ping");
        return Ok(HostResponse {
            status: ResponseStatus::Pong,
            job_id: None,
            client_job_id: request.client_job_id,
            message: "pong".to_string(),
        });
    }

    if matches!(request.kind.as_deref(), Some("reveal-output")) {
        return handle_reveal_request(request);
    }

    if matches!(request.kind.as_deref(), Some("abort")) {
        return handle_abort_request(request, job_manager);
    }

    let mpd_url = request.mpd_url.take().unwrap_or_default();
    if mpd_url.trim().is_empty() {
        return Ok(HostResponse {
            status: ResponseStatus::Error,
            job_id: None,
            client_job_id: request.client_job_id,
            message: "mpdUrl が空です".to_string(),
        });
    }

    let metadata: MetadataPayload = request
        .metadata
        .take()
        .map(|value| serde_json::from_value(value).context("metadata のパースに失敗しました"))
        .transpose()? // Option<Result<T>> -> Result<Option<T>>
        .unwrap_or_default();
    let requires_keys = metadata.requires_key_material();
    let keys = mem::take(&mut request.keys);
    if requires_keys && keys.is_empty() {
        return Ok(HostResponse {
            status: ResponseStatus::Error,
            job_id: None,
            client_job_id: request.client_job_id,
            message: "keys が見つかりません".to_string(),
        });
    }
    let output_dir = normalize_output_dir(request.output_dir.take())?;

    let validated = ValidatedRequest {
        mpd_url,
        source_url: request.source_url.take(),
        output_template: request.output_template.take(),
        keys,
        metadata,
        output_dir,
    };

    let job_id = job_manager.enqueue(validated, request.client_job_id.clone())?;
    Ok(HostResponse {
        status: ResponseStatus::Accepted,
        job_id: Some(job_id),
        client_job_id: request.client_job_id,
        message: "ジョブを受け付けました".to_string(),
    })
}

/// フォルダを開く要求を処理し、OS のファイルマネージャへ委譲します。
fn handle_reveal_request(mut request: DownloadRequest) -> Result<HostResponse> {
    let client_job_id = request.client_job_id.take();
    let raw_path = request.path.take().unwrap_or_default();
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Ok(HostResponse {
            status: ResponseStatus::Error,
            job_id: None,
            client_job_id,
            message: "path が空です".to_string(),
        });
    }
    let target = PathBuf::from(trimmed);
    log_event(format!("reveal request -> {}", target.display()));
    match reveal_in_file_manager(&target) {
        Ok(()) => Ok(HostResponse {
            status: ResponseStatus::Accepted,
            job_id: None,
            client_job_id,
            message: "フォルダを開きました".to_string(),
        }),
        Err(error) => Ok(HostResponse {
            status: ResponseStatus::Error,
            job_id: None,
            client_job_id,
            message: format!("フォルダを開けませんでした: {error}"),
        }),
    }
}

/// ジョブキャンセル要求を処理します。
fn handle_abort_request(
    mut request: DownloadRequest,
    job_manager: &JobManager,
) -> Result<HostResponse> {
    let client_job_id = request.client_job_id.take();
    let job_id = request.job_id.take();
    let cancelled = job_manager.abort(job_id.clone(), client_job_id.clone())?;
    Ok(HostResponse {
        status: if cancelled {
            ResponseStatus::Accepted
        } else {
            ResponseStatus::Error
        },
        job_id,
        client_job_id,
        message: if cancelled {
            "ジョブをキャンセルしました".to_string()
        } else {
            "対象ジョブが見つかりません".to_string()
        },
    })
}

/// ジョブ処理のための検証済みデータ。
#[derive(Debug, Clone)]
struct ValidatedRequest {
    mpd_url: String,
    source_url: Option<String>,
    output_template: Option<String>,
    keys: Vec<KeyEntry>,
    metadata: MetadataPayload,
    output_dir: Option<PathBuf>,
}

/// ジョブ投入のための文脈情報。
#[derive(Debug, Clone)]
struct JobContext {
    job_id: String,
    client_job_id: Option<String>,
    request: ValidatedRequest,
}

/// ジョブ投入コマンド。
enum JobCommand {
    Enqueue(JobContext),
    Abort(JobAbortRequest),
    WorkerFinished(String),
}

struct JobAbortRequest {
    job_id: Option<String>,
    client_job_id: Option<String>,
    responder: Sender<bool>,
}

struct ManagedJob {
    ctx: JobContext,
    control: JobControl,
}

struct ActiveJob {
    ctx: JobContext,
    control: JobControl,
    handle: Option<thread::JoinHandle<()>>,
}

/// ジョブ管理人。
struct JobManager {
    sender: Sender<JobCommand>,
}

impl JobManager {
    fn new(config: HostConfig, writer: MessageWriter) -> Self {
        let (sender, receiver) = unbounded::<JobCommand>();
        let control_sender = sender.clone();
        thread::spawn(move || run_scheduler(receiver, control_sender, config, writer));
        Self { sender }
    }

    fn enqueue(&self, request: ValidatedRequest, client_job_id: Option<String>) -> Result<String> {
        let job_id = Uuid::new_v4().to_string();
        let context = JobContext {
            job_id: job_id.clone(),
            client_job_id,
            request,
        };
        self.sender
            .send(JobCommand::Enqueue(context))
            .map_err(|err| anyhow!("ジョブの送信に失敗しました: {err}"))?;
        Ok(job_id)
    }

    fn abort(&self, job_id: Option<String>, client_job_id: Option<String>) -> Result<bool> {
        let (tx, rx) = bounded(1);
        let request = JobAbortRequest {
            job_id,
            client_job_id,
            responder: tx,
        };
        self.sender
            .send(JobCommand::Abort(request))
            .map_err(|err| anyhow!("ジョブ取消要求の送信に失敗しました: {err}"))?;
        rx.recv()
            .map_err(|err| anyhow!("ジョブ取消応答の受信に失敗しました: {err}"))
    }
}

fn run_scheduler(
    receiver: Receiver<JobCommand>,
    control_sender: Sender<JobCommand>,
    config: HostConfig,
    writer: MessageWriter,
) {
    let mut pending: VecDeque<ManagedJob> = VecDeque::new();
    let mut running: HashMap<String, ActiveJob> = HashMap::new();
    let mut client_map: HashMap<String, String> = HashMap::new();

    while let Ok(command) = receiver.recv() {
        match command {
            JobCommand::Enqueue(ctx) => {
                log_event(&format!("accepting job {}", &ctx.job_id));
                if let Some(client_id) = ctx.client_job_id.clone() {
                    client_map.insert(client_id, ctx.job_id.clone());
                }
                let control = JobControl::new();
                if running.len() >= MAX_CONCURRENT_JOBS {
                    send_waiting_signal(&ctx, &writer, &config);
                }
                pending.push_back(ManagedJob { ctx, control });
            }
            JobCommand::Abort(request) => {
                let target_job_id = resolve_job_id(
                    request.job_id.clone(),
                    request.client_job_id.clone(),
                    &client_map,
                );
                let cancelled = target_job_id
                    .as_deref()
                    .map(|job_id| {
                        let success =
                            cancel_job_by_id(job_id, &mut pending, &mut running, &writer, &config);
                        if success {
                            remove_client_mapping(&mut client_map, job_id);
                        }
                        success
                    })
                    .unwrap_or(false);
                let _ = request.responder.send(cancelled);
            }
            JobCommand::WorkerFinished(job_id) => {
                if let Some(mut active) = running.remove(&job_id) {
                    if let Some(handle) = active.handle.take() {
                        let _ = handle.join();
                    }
                    if let Some(client_id) = active.ctx.client_job_id.clone() {
                        client_map.remove(&client_id);
                    }
                }
            }
        }
        launch_ready_jobs(
            &mut pending,
            &mut running,
            &control_sender,
            &writer,
            &config,
        );
    }
}

fn send_waiting_signal(ctx: &JobContext, writer: &MessageWriter, config: &HostConfig) {
    let detail = format!("最大{}件の並列枠が空くのを待機中", MAX_CONCURRENT_JOBS);
    let output_root = job_output_root(ctx, config).to_path_buf();
    let _ = send_stage_event(
        writer,
        ctx,
        JobStage::Waiting,
        detail,
        0.0,
        None,
        output_root.as_path(),
    );
}

fn launch_ready_jobs(
    pending: &mut VecDeque<ManagedJob>,
    running: &mut HashMap<String, ActiveJob>,
    control_sender: &Sender<JobCommand>,
    writer: &MessageWriter,
    config: &HostConfig,
) {
    while running.len() < MAX_CONCURRENT_JOBS {
        let Some(job) = pending.pop_front() else {
            break;
        };
        let job_id = job.ctx.job_id.clone();
        let active = spawn_job_worker(job, control_sender.clone(), writer.clone(), config.clone());
        running.insert(job_id, active);
    }
}

fn spawn_job_worker(
    job: ManagedJob,
    completion_tx: Sender<JobCommand>,
    writer: MessageWriter,
    config: HostConfig,
) -> ActiveJob {
    let ctx_for_registry = job.ctx.clone();
    let control_for_registry = job.control.clone();
    let ctx = job.ctx;
    let control = job.control;
    let worker_writer = writer.clone();
    let worker_config = config.clone();
    let handle = thread::spawn(move || {
        let result = process_job(&ctx, &worker_config, &worker_writer, &control);
        if let Err(err) = result {
            let output_root = job_output_root(&ctx, &worker_config).to_path_buf();
            if err.downcast_ref::<CancelledError>().is_some() {
                log_event(&format!("job {} cancelled", &ctx.job_id));
                let _ = send_stage_event(
                    &worker_writer,
                    &ctx,
                    JobStage::Cancelled,
                    "ユーザーによって中止されました",
                    1.0,
                    None,
                    output_root.as_path(),
                );
                let _ = persist_job_record(&worker_config, &ctx, None, false);
            } else {
                log_event(&format!("job {} failed: {err:?}", &ctx.job_id));
                let detail = format!("失敗: {err}");
                let _ = send_stage_event(
                    &worker_writer,
                    &ctx,
                    JobStage::Failed,
                    detail,
                    1.0,
                    None,
                    output_root.as_path(),
                );
                let _ = persist_job_record(&worker_config, &ctx, None, false);
            }
        }
        let _ = completion_tx.send(JobCommand::WorkerFinished(ctx.job_id.clone()));
    });
    ActiveJob {
        ctx: ctx_for_registry,
        control: control_for_registry,
        handle: Some(handle),
    }
}

fn resolve_job_id(
    job_id: Option<String>,
    client_job_id: Option<String>,
    client_map: &HashMap<String, String>,
) -> Option<String> {
    if let Some(id) = job_id.and_then(non_empty_string) {
        return Some(id);
    }
    if let Some(client_id) = client_job_id.and_then(non_empty_string) {
        return client_map.get(&client_id).cloned();
    }
    None
}

fn non_empty_string(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn cancel_job_by_id(
    job_id: &str,
    pending: &mut VecDeque<ManagedJob>,
    running: &mut HashMap<String, ActiveJob>,
    writer: &MessageWriter,
    config: &HostConfig,
) -> bool {
    if let Some(index) = pending.iter().position(|job| job.ctx.job_id == job_id) {
        if let Some(managed) = pending.remove(index) {
            let output_root = job_output_root(&managed.ctx, config).to_path_buf();
            let _ = send_stage_event(
                writer,
                &managed.ctx,
                JobStage::Cancelled,
                "開始前にキャンセルしました",
                0.0,
                None,
                output_root.as_path(),
            );
            let _ = persist_job_record(config, &managed.ctx, None, false);
            return true;
        }
    }
    if let Some(active) = running.get(job_id) {
        let output_root = job_output_root(&active.ctx, config).to_path_buf();
        let _ = send_stage_event(
            writer,
            &active.ctx,
            JobStage::Cancelling,
            "ユーザー操作で停止処理中",
            0.0,
            None,
            output_root.as_path(),
        );
        log_event(format!(
            "job {} cancel requested (running)",
            active.ctx.job_id
        ));
        active.control.request_cancel(Some(&active.ctx.job_id));
        return true;
    }
    false
}

fn remove_client_mapping(map: &mut HashMap<String, String>, job_id: &str) {
    if let Some(key) = map.iter().find_map(|(client, mapped)| {
        if mapped == job_id {
            Some(client.clone())
        } else {
            None
        }
    }) {
        map.remove(&key);
    }
}

#[derive(Clone)]
struct JobControl {
    cancelled: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Arc<SharedChild>>>>,
}

impl JobControl {
    /// キャンセル制御用の共有状態を初期化します。
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// 現在実行中の子プロセスに終了要求を伝播します。
    /// キャンセル状態へ遷移させ、子プロセスへ終了シグナルを伝えます。
    fn request_cancel(&self, label: Option<&str>) {
        self.cancelled.store(true, Ordering::SeqCst);
        let prefix = label.unwrap_or("job-control");
        let child_opt = self.child.lock().unwrap().clone();
        if let Some(child) = child_opt {
            let pid = child.id();
            match child.kill() {
                Ok(_) => {
                    log_event(format!("[cancel] {prefix}: sent kill to pid {pid}"));
                }
                Err(error) => {
                    log_event(format!(
                        "[cancel] {prefix}: kill failed for pid {pid}: {error}"
                    ));
                }
            }
        } else {
            log_event(format!(
                "[cancel] {prefix}: cancel requested but child slot empty"
            ));
        }
    }

    /// キャンセルされていないことを確認します。
    fn ensure_active(&self) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(CancelledError.into());
        }
        Ok(())
    }

    /// 子プロセスを監視対象として登録します。
    fn track_child(&self, child: Arc<SharedChild>) -> TrackedChild {
        {
            let mut slot = self.child.lock().unwrap();
            *slot = Some(child.clone());
        }
        if self.is_cancelled() {
            let pid = child.id();
            if let Err(error) = child.kill() {
                log_event(format!(
                    "[cancel] job-control: late child kill failed for pid {pid}: {error}"
                ));
            } else {
                log_event(format!(
                    "[cancel] job-control: late child kill issued for pid {pid}"
                ));
            }
        }
        TrackedChild {
            control: self.clone(),
            child: Some(child),
            consumed: false,
        }
    }

    /// 現在のキャンセル状態を返します。
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// 指定されたハンドルが最新の子プロセスなら記録を解放します。
    fn release_child_if_current(&self, child: &Arc<SharedChild>) {
        let mut slot = self.child.lock().unwrap();
        if let Some(current) = slot.as_ref() {
            if Arc::ptr_eq(current, child) {
                *slot = None;
            }
        }
    }
}

/// 子プロセスを安全に待機させるための RAII ガードです。
struct TrackedChild {
    control: JobControl,
    child: Option<Arc<SharedChild>>,
    consumed: bool,
}

impl TrackedChild {
    /// 子プロセスの終了を待ち、完了後にトラッキングを解放します。
    fn wait(mut self) -> io::Result<process::ExitStatus> {
        let Some(child) = self.child.take() else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "child process not found",
            ));
        };
        let status = child.wait();
        self.control.release_child_if_current(&child);
        self.consumed = true;
        status
    }

    /// 指定秒数で子プロセス待機を打ち切り、タイムアウト時は cancel を要求します。
    fn wait_with_timeout(mut self, timeout: Duration) -> io::Result<process::ExitStatus> {
        let Some(child) = self.child.take() else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "child process not found",
            ));
        };
        let cloned = child.clone();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = cloned.wait();
            let _ = tx.send(result);
        });
        let result = match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.control.request_cancel(Some("wait-timeout"));
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "child wait timeout",
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::Other,
                "wait thread disconnected",
            )),
        };
        self.control.release_child_if_current(&child);
        self.consumed = true;
        result
    }
}

impl Drop for TrackedChild {
    fn drop(&mut self) {
        if self.consumed {
            return;
        }
        if let Some(child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
            self.control.release_child_if_current(&child);
        }
    }
}

/// プロセス標準出力/標準エラーの末尾を保持するリングバッファです。
struct ProcessLogBuffer {
    capacity: usize,
    data: VecDeque<u8>,
}

impl ProcessLogBuffer {
    /// 保持バイト数を指定して初期化します。
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            data: VecDeque::with_capacity(capacity),
        }
    }

    /// 読み取ったチャンクを末尾へ追加し、容量超過分は先頭から捨てます。
    fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= self.capacity {
            self.data.clear();
            self.data
                .extend(chunk[chunk.len() - self.capacity..].iter().copied());
            return;
        }
        while self.data.len() + chunk.len() > self.capacity {
            self.data.pop_front();
        }
        self.data.extend(chunk.iter().copied());
    }

    /// バッファ末尾を UTF-8 文字列として返します（非UTF-8はロスレス変換）。
    fn tail_as_string(&self) -> String {
        let (first, second) = self.data.as_slices();
        let mut combined = Vec::with_capacity(first.len() + second.len());
        combined.extend_from_slice(first);
        combined.extend_from_slice(second);
        String::from_utf8_lossy(&combined).into_owned()
    }
}

/// 子プロセスのストリームを吸い上げ、リングバッファ保全と任意ログ出力を行います。
fn spawn_stream_reader<R>(
    mut reader: R,
    label: &'static str,
    buffer: Arc<Mutex<ProcessLogBuffer>>,
    emit_log: bool,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        let mut pending = String::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(len) => {
                    if let Ok(mut guard) = buffer.lock() {
                        guard.push(&chunk[..len]);
                    }
                    if emit_log {
                        pending.push_str(&String::from_utf8_lossy(&chunk[..len]));
                        while let Some(pos) = pending.find('\n') {
                            let line = pending[..pos].trim_end();
                            if !line.is_empty() {
                                log_event(format!("[{label}] {line}"));
                            }
                            pending.drain(..=pos);
                        }
                        if pending.len() > 2048 {
                            pending.clear();
                        }
                    }
                }
                Err(error) => {
                    log_event(format!("[{label}] stream read error: {error}"));
                    break;
                }
            }
        }
        if emit_log {
            let tail = pending.trim_end();
            if !tail.is_empty() {
                log_event(format!("[{label}] {tail}"));
            }
        }
    })
}

#[derive(Debug)]
struct CancelledError;

impl fmt::Display for CancelledError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "job cancelled")
    }
}

impl std::error::Error for CancelledError {}

fn job_output_root<'a>(ctx: &'a JobContext, config: &'a HostConfig) -> &'a Path {
    ctx.request
        .output_dir
        .as_deref()
        .unwrap_or(&config.output_root)
}

/// ホスト設定。
#[derive(Clone)]
struct HostConfig {
    yt_dlp: PathBuf,
    mp4decrypt: PathBuf,
    ffmpeg: PathBuf,
    output_root: PathBuf,
    cookies_profile: String,
    quiet: bool,
    state_file: PathBuf,
    keep_debug_artifacts: bool,
}

impl HostConfig {
    fn detect() -> Result<Self> {
        let yt_dlp = resolve_binary("WIDEVINEPROXY2_BIN_yt_dlp", "yt-dlp")?;
        let mp4decrypt = resolve_binary("WIDEVINEPROXY2_BIN_mp4decrypt", "mp4decrypt")?;
        let ffmpeg = resolve_binary("WIDEVINEPROXY2_BIN_ffmpeg", "ffmpeg")?;

        let output_root = env::var("WIDEVINEPROXY2_OUTPUT_DIR")
            .map(PathBuf::from)
            .ok()
            .or_else(|| resolve_home_dir().map(|home| home.join(default_output_leaf())))
            .unwrap_or_else(|| fallback_output_root());
        fs::create_dir_all(&output_root).with_context(|| {
            format!(
                "出力ディレクトリの作成に失敗しました: {}",
                output_root.display()
            )
        })?;

        let state_file = env::var("WIDEVINEPROXY2_STATE_FILE")
            .map(PathBuf::from)
            .ok()
            .or_else(|| resolve_home_dir().map(|home| default_state_file(&home)))
            .unwrap_or_else(|| fallback_output_root().join("jobs.json"));
        if let Some(parent) = state_file.parent() {
            fs::create_dir_all(parent).ok();
        }

        let cookies_profile =
            env::var("WIDEVINEPROXY2_COOKIES").unwrap_or_else(|_| "chrome:Default".to_string());
        let quiet = env_flag("WIDEVINEPROXY2_QUIET", false);
        let keep_debug_artifacts = env_flag("WIDEVINEPROXY2_KEEP_DEBUG_ARTIFACTS", false);
        log_event(format!(
            "config detected: yt-dlp={:?}, mp4decrypt={:?}, ffmpeg={:?}, output_root={}, cookies_profile={}, keep_debug_artifacts={}",
            yt_dlp,
            mp4decrypt,
            ffmpeg,
            output_root.display(),
            cookies_profile,
            keep_debug_artifacts
        ));

        Ok(Self {
            yt_dlp,
            mp4decrypt,
            ffmpeg,
            output_root,
            cookies_profile,
            quiet,
            state_file,
            keep_debug_artifacts,
        })
    }
}

/// OS ごとに適切な動画フォルダ名を返します。
fn default_output_leaf() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        return PathBuf::from("Videos");
    }
    PathBuf::from("Movies")
}

/// HOME が取得できない場合の最終フォルダです。
fn fallback_output_root() -> PathBuf {
    env::temp_dir().join("WidevineProxy2")
}

/// Windows を含め HOME 相当を見つけます。
fn resolve_home_dir() -> Option<PathBuf> {
    if let Ok(home) = env::var("HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = env::var("USERPROFILE") {
            if !profile.trim().is_empty() {
                return Some(PathBuf::from(profile));
            }
        }
        if let (Ok(drive), Ok(path)) = (env::var("HOMEDRIVE"), env::var("HOMEPATH")) {
            if !drive.trim().is_empty() && !path.trim().is_empty() {
                return Some(PathBuf::from(format!("{}{}", drive, path)));
            }
        }
    }
    None
}

/// OS 別のジョブログ保存先を返します。
fn default_state_file(home: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        return home
            .join("AppData")
            .join("Local")
            .join("WidevineProxy2")
            .join("jobs.json");
    }
    #[cfg(target_os = "macos")]
    {
        return home
            .join("Library")
            .join("Logs")
            .join("WidevineProxy2")
            .join("jobs.json");
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        return home
            .join(".local")
            .join("share")
            .join("WidevineProxy2")
            .join("jobs.json");
    }
}

fn normalize_output_dir(raw: Option<String>) -> Result<Option<PathBuf>> {
    let Some(raw_value) = raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let expanded = if raw_value == "~" {
        resolve_home_dir().unwrap_or_else(|| PathBuf::from("~"))
    } else if raw_value.starts_with("~/") || raw_value.starts_with("~\\") {
        let remainder = raw_value.trim_start_matches("~/").trim_start_matches("~\\");
        if let Some(home) = resolve_home_dir() {
            home.join(remainder)
        } else {
            PathBuf::from(remainder)
        }
    } else {
        PathBuf::from(&raw_value)
    };
    let absolute = if expanded.is_absolute() {
        expanded
    } else if let Some(home) = resolve_home_dir() {
        home.join(expanded)
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(expanded)
    };
    fs::create_dir_all(&absolute).with_context(|| {
        format!(
            "出力ディレクトリの作成に失敗しました: {}",
            absolute.display()
        )
    })?;
    Ok(Some(absolute))
}

/// ジョブ固有のディレクトリ群。
struct JobPaths {
    staging_root: PathBuf,
    encrypted: PathBuf,
    decrypted: PathBuf,
}

impl JobPaths {
    fn new(job_id: &str) -> Result<Self> {
        let timestamp = now_secs();
        let staging_root = env::temp_dir()
            .join("WidevineProxy2")
            .join(format!("{}-{}", timestamp, job_id));
        let encrypted = staging_root.join("encrypted");
        let decrypted = staging_root.join("decrypted");
        fs::create_dir_all(&encrypted)?;
        fs::create_dir_all(&decrypted)?;
        Ok(Self {
            staging_root,
            encrypted,
            decrypted,
        })
    }
}

struct DownloadArtifacts {
    video: PathBuf,
    audio: PathBuf,
    base_label: String,
}

struct DecryptedArtifacts {
    video: PathBuf,
    audio: PathBuf,
    base_label: String,
}

/// ジョブの実処理。
fn process_job(
    ctx: &JobContext,
    config: &HostConfig,
    writer: &MessageWriter,
    control: &JobControl,
) -> Result<()> {
    log_event(format!("job {} pipeline executing", ctx.job_id));
    let output_root = job_output_root(ctx, config);
    let paths = JobPaths::new(&ctx.job_id)?;
    let result: Result<PathBuf> = (|| {
        control.ensure_active()?;
        send_stage_event(
            writer,
            ctx,
            JobStage::Queued,
            "キュー追加",
            0.0,
            None,
            output_root,
        )?;
        control.ensure_active()?;
        send_stage_event(
            writer,
            ctx,
            JobStage::Preparing,
            "yt-dlp を初期化中",
            0.02,
            None,
            output_root,
        )?;
        control.ensure_active()?;
        send_stage_event(
            writer,
            ctx,
            JobStage::Downloading,
            "yt-dlp でダウンロードを開始",
            0.05,
            None,
            output_root,
        )?;
        log_event(format!("job {} starting yt-dlp", ctx.job_id));
        let download = run_yt_dlp(ctx, config, &paths, writer, output_root, control)?;
        let needs_decrypt = !ctx.request.keys.is_empty();
        let decrypted = if needs_decrypt {
            control.ensure_active()?;
            send_stage_event(
                writer,
                ctx,
                JobStage::Decrypting,
                "mp4decrypt 実行中",
                0.7,
                None,
                output_root,
            )?;
            log_event(format!("job {} starting mp4decrypt", ctx.job_id));
            run_mp4decrypt(ctx, config, &paths, &download, control)?
        } else {
            send_stage_event(
                writer,
                ctx,
                JobStage::Decrypting,
                "暗号化されていないストリームのため復号をスキップ",
                0.7,
                None,
                output_root,
            )?;
            promote_clear_artifacts(&download)
        };
        let final_basename = resolve_final_basename(ctx, &decrypted);
        let final_target = output_root.join(format!("{}.mp4", final_basename));
        control.ensure_active()?;
        send_stage_event(
            writer,
            ctx,
            JobStage::Muxing,
            "ffmpeg で結合中",
            0.9,
            None,
            output_root,
        )?;
        log_event(format!("job {} starting ffmpeg", ctx.job_id));
        let final_path = run_ffmpeg_merge(config, &decrypted, &final_target, control)?;
        send_stage_event(
            writer,
            ctx,
            JobStage::Completed,
            "ダウンロード完了",
            1.0,
            Some(final_path.clone()),
            output_root,
        )?;
        log_event(format!(
            "job {} completed -> {}",
            ctx.job_id,
            final_path.display()
        ));
        persist_job_record(config, ctx, Some(&final_path), true)?;
        Ok(final_path)
    })();

    match result {
        Ok(_) => {
            if !config.keep_debug_artifacts {
                if let Err(err) = cleanup_success_artifacts(&paths) {
                    log_event(format!("artifact cleanup failed: {err:?}"));
                }
            } else {
                log_event("debug artifact retention enabled; skipping cleanup");
            }
            Ok(())
        }
        Err(error) => {
            if !config.keep_debug_artifacts {
                if let Err(err) = cleanup_success_artifacts(&paths) {
                    log_event(format!("artifact cleanup failed: {err:?}"));
                }
            }
            Err(error)
        }
    }
}

fn run_yt_dlp(
    ctx: &JobContext,
    config: &HostConfig,
    paths: &JobPaths,
    writer: &MessageWriter,
    output_root: &Path,
    control: &JobControl,
) -> Result<DownloadArtifacts> {
    control.ensure_active()?;
    let mut command = Command::new(&config.yt_dlp);
    command
        .arg(&ctx.request.mpd_url)
        .arg("-f")
        .arg("bv*+ba/b")
        .arg("--allow-unplayable-formats")
        .arg("--no-part")
        .arg("--concurrent-fragments")
        .arg("5")
        .arg("--newline");

    match resolve_cookie_mode(config, &ctx.request.metadata) {
        CookieMode::Browser(profile) => {
            command.arg("--cookies-from-browser").arg(profile);
        }
        CookieMode::Netscape(path) => {
            command.arg("--cookies").arg(path);
        }
    }

    let headers = &ctx.request.metadata.headers;
    if let Some(ua) = header_value(headers, "user-agent") {
        command.arg("--user-agent").arg(ua);
    }
    if let Some(referer) = header_value(headers, "referer") {
        command.arg("--referer").arg(referer);
    }
    for (name, value) in headers {
        if value.trim().is_empty() {
            continue;
        }
        command
            .arg("--add-header")
            .arg(format!("{}: {}", name, value));
    }

    let output_template = ctx
        .request
        .output_template
        .clone()
        .or_else(|| {
            ctx.request
                .metadata
                .output_slug
                .clone()
                .map(|slug| format!("{slug}.%(ext)s"))
        })
        .unwrap_or_else(|| "%(title)s-%(id)s.%(ext)s".to_string());
    let template_path = paths.encrypted.join(&output_template);
    command
        .arg("--output")
        .arg(template_path.to_string_lossy().to_string());

    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let shared_child =
        Arc::new(SharedChild::spawn(&mut command).context("yt-dlp の起動に失敗しました")?);
    let tracker_guard = control.track_child(shared_child.clone());
    let stdout = shared_child.take_stdout();
    if let Some(stdout) = stdout {
        let job = ctx.clone();
        let writer = writer.clone();
        let progress_root = output_root.to_path_buf();
        let control_flag = control.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut tracker = StreamProgressTracker::default();
            for raw_line in reader.lines().flatten() {
                if control_flag.is_cancelled() {
                    break;
                }
                let trimmed = raw_line.trim_end().to_string();
                if let Some(file_name) = parse_destination_line(&trimmed) {
                    tracker.set_current(file_name.clone());
                    log_event(format!("job {} destination {}", job.job_id, file_name));
                    continue;
                }
                if let Some(sample) = parse_default_progress_line(&trimmed) {
                    let stream = tracker.current();
                    if !tracker.should_emit(sample.fraction) {
                        continue;
                    }
                    let detail = format_stream_progress_detail(&stream, &sample);
                    let mapped = map_stream_progress(stream.kind, sample.fraction);
                    let _ = send_stage_event(
                        &writer,
                        &job,
                        JobStage::Downloading,
                        detail,
                        mapped,
                        None,
                        progress_root.as_path(),
                    );
                }
            }
        });
    }

    let stderr = shared_child.take_stderr();
    let stderr_handle = stderr.map(|handle| {
        thread::spawn(move || {
            let reader = BufReader::new(handle);
            reader.lines().flatten().collect::<Vec<String>>().join("\n")
        })
    });

    let status = tracker_guard
        .wait()
        .context("yt-dlp の終了待ちに失敗しました")?;
    let stderr_output = stderr_handle
        .map(|h| h.join().unwrap_or_default())
        .unwrap_or_default();
    if !status.success() {
        if control.cancelled.load(Ordering::SeqCst) {
            return Err(CancelledError.into());
        }
        return Err(anyhow!(
            "yt-dlp が異常終了しました (code={:?})\n{}",
            status.code(),
            stderr_output
        ));
    }

    collect_download_outputs(&paths.encrypted)
}

/// Cookie 取得方法を表します。
enum CookieMode {
    Browser(String),
    Netscape(String),
}

/// yt-dlp へ渡す Cookie モードと値を判定します。
fn resolve_cookie_mode(config: &HostConfig, metadata: &MetadataPayload) -> CookieMode {
    let strategy = metadata
        .cookies
        .strategy
        .as_deref()
        .unwrap_or("browser")
        .to_ascii_lowercase();
    let profile = metadata
        .cookies
        .profile
        .clone()
        .unwrap_or_else(|| config.cookies_profile.clone());
    if strategy == "netscape" {
        CookieMode::Netscape(profile)
    } else {
        CookieMode::Browser(profile)
    }
}

fn collect_download_outputs(dir: &Path) -> Result<DownloadArtifacts> {
    let video = pick_latest(dir, &["mp4", "m4v"]).context("動画トラックが見つかりませんでした")?;
    let audio = pick_latest(dir, &["m4a", "mp4"]).context("音声トラックが見つかりませんでした")?;
    let base_label = video
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(sanitize_filename_component)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "output".to_string());
    Ok(DownloadArtifacts {
        video,
        audio,
        base_label,
    })
}

/// ファイル名として安全かつ人間が読みやすい文字列へ整形します。
fn sanitize_filename_component(input: &str) -> String {
    let mut buffer = String::with_capacity(input.len());
    for ch in input.chars() {
        // Windows の禁止文字と制御文字のみ除去・置換する
        if (ch as u32) < 0x20 || ch == '\u{7f}' {
            continue;
        }
        if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            buffer.push(' ');
            continue;
        }
        buffer.push(ch);
    }
    let collapsed = buffer.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        "output".to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_final_basename(ctx: &JobContext, decrypted: &DecryptedArtifacts) -> String {
    if let Some(slug) = ctx.request.metadata.output_slug.as_deref() {
        let trimmed = slug.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    sanitize_filename_component(&decrypted.base_label)
}

fn pick_latest(dir: &Path, exts: &[&str]) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .unwrap_or_default();
        if exts.iter().any(|needle| needle == &ext.as_str()) {
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(UNIX_EPOCH);
            candidates.push((modified, path));
        }
    }
    candidates
        .into_iter()
        .max_by_key(|(time, _)| *time)
        .map(|(_, path)| path)
        .ok_or_else(|| anyhow!("該当するファイルが見つかりません"))
}

fn run_mp4decrypt(
    ctx: &JobContext,
    config: &HostConfig,
    paths: &JobPaths,
    download: &DownloadArtifacts,
    control: &JobControl,
) -> Result<DecryptedArtifacts> {
    let video_output = paths
        .decrypted
        .join(format!("{}-video.mp4", download.base_label));
    let audio_output = paths
        .decrypted
        .join(format!("{}-audio.m4a", download.base_label));

    decrypt_track(
        &config.mp4decrypt,
        &ctx.request.keys,
        &download.video,
        &video_output,
        "video",
        control,
    )?;
    decrypt_track(
        &config.mp4decrypt,
        &ctx.request.keys,
        &download.audio,
        &audio_output,
        "audio",
        control,
    )?;

    Ok(DecryptedArtifacts {
        video: video_output,
        audio: audio_output,
        base_label: download.base_label.clone(),
    })
}

/// 暗号化されていない出力を復号済みアーティファクトとして扱います。
fn promote_clear_artifacts(download: &DownloadArtifacts) -> DecryptedArtifacts {
    DecryptedArtifacts {
        video: download.video.clone(),
        audio: download.audio.clone(),
        base_label: download.base_label.clone(),
    }
}

fn decrypt_track(
    binary: &Path,
    keys: &[KeyEntry],
    input: &Path,
    output: &Path,
    label: &str,
    control: &JobControl,
) -> Result<()> {
    control.ensure_active()?;
    let mut command = Command::new(binary);
    for key in keys {
        let spec = format!("{}:{}", key.kid, key.key);
        command.arg("--key").arg(spec);
    }
    command.arg(input).arg(output);
    let shared_child = Arc::new(
        SharedChild::spawn(&mut command)
            .with_context(|| format!("mp4decrypt({label}) の起動に失敗しました"))?,
    );
    let status = control
        .track_child(shared_child)
        .wait()
        .with_context(|| format!("mp4decrypt({label}) の終了待ちに失敗しました"))?;
    if !status.success() {
        if control.cancelled.load(Ordering::SeqCst) {
            return Err(CancelledError.into());
        }
        return Err(anyhow!(
            "mp4decrypt({}) が失敗しました (code={:?})",
            label,
            status.code()
        ));
    }
    Ok(())
}

fn run_ffmpeg_merge(
    config: &HostConfig,
    decrypted: &DecryptedArtifacts,
    final_target: &Path,
    control: &JobControl,
) -> Result<PathBuf> {
    control.ensure_active()?;
    if let Some(parent) = final_target.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!("出力ディレクトリ({})の作成に失敗しました", parent.display())
        })?;
    }
    let mut command = Command::new(&config.ffmpeg);
    command
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(&decrypted.video)
        .arg("-i")
        .arg(&decrypted.audio)
        .arg("-c:v")
        .arg("copy")
        .arg("-c:a")
        .arg("copy")
        .arg(final_target)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let shared_child =
        Arc::new(SharedChild::spawn(&mut command).context("ffmpeg の実行に失敗しました")?);
    let log_buffer = Arc::new(Mutex::new(ProcessLogBuffer::new(PROCESS_LOG_LIMIT_BYTES)));
    let mut stdout_handle = shared_child.take_stdout().map(|stdout| {
        spawn_stream_reader(stdout, "ffmpeg:stdout", log_buffer.clone(), !config.quiet)
    });
    let mut stderr_handle = shared_child.take_stderr().map(|stderr| {
        spawn_stream_reader(stderr, "ffmpeg:stderr", log_buffer.clone(), !config.quiet)
    });

    let wait_duration = Duration::from_secs(FFMPEG_MERGE_TIMEOUT_SECS);
    let wait_result = control
        .track_child(shared_child.clone())
        .wait_with_timeout(wait_duration);
    let status = match wait_result {
        Ok(status) => status,
        Err(error) => {
            if let Some(handle) = stdout_handle.take() {
                let _ = handle.join();
            }
            if let Some(handle) = stderr_handle.take() {
                let _ = handle.join();
            }
            if error.kind() == io::ErrorKind::TimedOut {
                let tail = log_buffer
                    .lock()
                    .map(|buf| buf.tail_as_string())
                    .unwrap_or_default();
                return Err(anyhow!(
                    "ffmpeg の結合がタイムアウトしました (>{}秒) tail={}",
                    FFMPEG_MERGE_TIMEOUT_SECS,
                    tail
                ));
            }
            return Err(error).context("ffmpeg の終了待ちに失敗しました");
        }
    };

    if let Some(handle) = stdout_handle.take() {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_handle.take() {
        let _ = handle.join();
    }

    if !status.success() {
        if control.cancelled.load(Ordering::SeqCst) {
            return Err(CancelledError.into());
        }
        let tail = log_buffer
            .lock()
            .map(|buf| buf.tail_as_string())
            .unwrap_or_default();
        return Err(anyhow!(
            "ffmpeg が失敗しました (code={:?}) tail={}",
            status.code(),
            tail
        ));
    }
    Ok(final_target.to_path_buf())
}

/// 成功時に暗号化・復号ディレクトリを削除してディスク使用量を抑えます。
fn cleanup_success_artifacts(paths: &JobPaths) -> Result<()> {
    if paths.staging_root.exists() {
        fs::remove_dir_all(&paths.staging_root).with_context(|| {
            format!(
                "ステージングディレクトリ({})の削除に失敗しました",
                paths.staging_root.display()
            )
        })?;
    }
    Ok(())
}

/// ファイルまたはディレクトリを OS ネイティブ UI で開きます。
fn reveal_in_file_manager(path: &Path) -> Result<()> {
    let normalized = path.to_path_buf();
    let directory = if normalized.is_dir() {
        normalized.clone()
    } else if let Some(parent) = normalized.parent() {
        parent.to_path_buf()
    } else {
        normalized.clone()
    };
    if !directory.exists() {
        return Err(anyhow!(
            "対象ディレクトリが存在しません: {}",
            directory.display()
        ));
    }
    let directory = directory.canonicalize().unwrap_or(directory);
    let file_target = if normalized.exists() && normalized.is_file() {
        Some(normalized.canonicalize().unwrap_or(normalized.clone()))
    } else {
        None
    };
    log_event(format!(
        "revealing directory {} (original: {})",
        directory.display(),
        path.display()
    ));

    #[cfg(target_os = "macos")]
    {
        if let Some(file) = &file_target {
            let mut command = Command::new("open");
            command.arg("-R").arg(file);
            return run_command(command);
        }
        let mut command = Command::new("open");
        command.arg(&directory);
        return run_command(command);
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        if let Some(file) = &file_target {
            command.arg("/select,").arg(file);
        } else {
            command.arg(&directory);
        }
        return run_command(command);
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(&directory);
        return run_command(command);
    }
}

/// 共通のコマンド実行ラッパーです。
fn run_command(mut command: Command) -> Result<()> {
    let status = command
        .status()
        .context("パス表示コマンドの実行に失敗しました")?;
    if status.success() {
        return Ok(());
    }
    Err(anyhow!(
        "パス表示コマンドが異常終了しました (code={:?})",
        status.code()
    ))
}

#[derive(Clone)]
struct StreamInfo {
    file_name: String,
    kind: StreamKind,
}

impl StreamInfo {
    fn new(file_name: String) -> Self {
        let kind = StreamKind::from_filename(&file_name);
        Self { file_name, kind }
    }

    fn placeholder() -> Self {
        Self {
            file_name: "stream".to_string(),
            kind: StreamKind::Other,
        }
    }
}

#[derive(Clone, Copy)]
enum StreamKind {
    Video,
    Audio,
    Other,
}

impl StreamKind {
    fn from_filename(file_name: &str) -> Self {
        let ext = Path::new(file_name)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "mp4" | "m4v" | "webm" | "ts" | "mkv" => StreamKind::Video,
            "m4a" | "aac" | "mp3" | "ogg" | "flac" => StreamKind::Audio,
            _ => StreamKind::Other,
        }
    }

    fn label(&self) -> &'static str {
        match self {
            StreamKind::Video => "動画",
            StreamKind::Audio => "音声",
            StreamKind::Other => "トラック",
        }
    }

    fn progress_band(&self) -> (f32, f32) {
        match self {
            StreamKind::Video => (0.05, 0.45),
            StreamKind::Audio => (0.5, 0.25),
            StreamKind::Other => (0.05, 0.65),
        }
    }
}

#[derive(Default)]
struct StreamProgressTracker {
    current: Option<StreamInfo>,
    last_fraction: Option<f32>,
    last_emit_at: Option<Instant>,
}

impl StreamProgressTracker {
    fn set_current(&mut self, file_name: String) {
        self.current = Some(StreamInfo::new(file_name));
        self.last_fraction = None;
        self.last_emit_at = None;
    }

    fn current(&self) -> StreamInfo {
        self.current.clone().unwrap_or_else(StreamInfo::placeholder)
    }

    fn should_emit(&mut self, fraction: f32) -> bool {
        let now = Instant::now();
        let fraction_delta_ok = self
            .last_fraction
            .map(|last| (fraction - last).abs() >= 0.02)
            .unwrap_or(true);
        let time_delta_ok = self
            .last_emit_at
            .map(|instant| now.duration_since(instant) >= Duration::from_millis(400))
            .unwrap_or(true);
        if fraction_delta_ok || time_delta_ok {
            self.last_fraction = Some(fraction);
            self.last_emit_at = Some(now);
            return true;
        }
        false
    }
}

struct DefaultProgressSample {
    fraction: f32,
    percent_label: String,
    size_label: Option<String>,
    speed_label: Option<String>,
    eta_label: Option<String>,
    frag_current: Option<u32>,
    frag_total: Option<u32>,
}

fn parse_destination_line(line: &str) -> Option<String> {
    static DEST_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = DEST_REGEX
        .get_or_init(|| Regex::new(r#"^\[download\]\s+Destination:\s+(?P<name>.+)$"#).unwrap());
    let captures = regex.captures(line.trim())?;
    Some(captures.name("name")?.as_str().trim().to_string())
}

fn parse_default_progress_line(line: &str) -> Option<DefaultProgressSample> {
    static PROGRESS_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = PROGRESS_REGEX.get_or_init(|| {
        Regex::new(
            r#"(?x)
^\[download\]\s+
(?P<percent>\d+(?:\.\d+)?)%
.*?
\bof\b\s+(?P<size>~?\s*[\d\.\w]+)?
.*?
(?:at\s+(?P<speed>[\d\.\w/]+))?
.*?
(?:ETA\s+(?P<eta>[0-9:\-]+|Unknown))?
.*?(?:\(frag\s+(?P<frag_cur>\d+)\/(?P<frag_total>\d+)\))?
"#,
        )
        .expect("progress regex")
    });
    let captures = regex.captures(line.trim())?;
    let percent = captures.name("percent")?.as_str();
    let fraction = percent.parse::<f32>().ok()? / 100.0;
    let size_label = captures
        .name("size")
        .map(|m| m.as_str().trim().to_string())
        .filter(|v| !v.is_empty());
    let speed_label = captures
        .name("speed")
        .map(|m| m.as_str().trim().to_string())
        .filter(|v| !v.is_empty());
    let eta_label = captures
        .name("eta")
        .map(|m| m.as_str().trim().to_string())
        .filter(|v| !v.is_empty() && v != "--:--:--" && v != "Unknown");
    let frag_current = captures
        .name("frag_cur")
        .and_then(|m| m.as_str().parse::<u32>().ok());
    let frag_total = captures
        .name("frag_total")
        .and_then(|m| m.as_str().parse::<u32>().ok());
    Some(DefaultProgressSample {
        fraction: fraction.clamp(0.0, 1.0),
        percent_label: format!("{percent}%"),
        size_label,
        speed_label,
        eta_label,
        frag_current,
        frag_total,
    })
}

fn format_stream_progress_detail(stream: &StreamInfo, sample: &DefaultProgressSample) -> String {
    let mut parts = vec![format!("{} {}", stream.kind.label(), sample.percent_label)];
    if let Some(name) = Path::new(&stream.file_name)
        .file_name()
        .and_then(|value| value.to_str())
    {
        parts.push(name.to_string());
    }
    if let Some(size) = sample.size_label.as_deref() {
        parts.push(size.trim().to_string());
    }
    if let Some(speed) = sample.speed_label.as_deref() {
        parts.push(format!("@ {}", speed));
    }
    if let Some((current, total)) = sample.frag_current.zip(sample.frag_total) {
        parts.push(format!("frag {}/{}", current, total));
    }
    if let Some(eta) = sample.eta_label.as_deref() {
        parts.push(format!("ETA {}", eta));
    }
    parts.join(" / ")
}

fn map_stream_progress(kind: StreamKind, fraction: f32) -> f32 {
    let (offset, span) = kind.progress_band();
    (offset + span * fraction).clamp(0.0, 0.95)
}

#[derive(Serialize)]
struct JobProgressEvent {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "jobId")]
    job_id: String,
    #[serde(rename = "clientJobId")]
    client_job_id: Option<String>,
    stage: JobStage,
    status: String,
    progress: f32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_path: Option<String>,
    #[serde(rename = "outputDir", skip_serializing_if = "Option::is_none")]
    output_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mpd_url: Option<String>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum JobStage {
    Waiting,
    Queued,
    Preparing,
    Downloading,
    Decrypting,
    Muxing,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
}

fn send_stage_event(
    writer: &MessageWriter,
    ctx: &JobContext,
    stage: JobStage,
    detail: impl Into<String>,
    progress: f32,
    output_path: Option<PathBuf>,
    output_root: &Path,
) -> Result<()> {
    let event = JobProgressEvent {
        kind: "job-progress",
        job_id: ctx.job_id.clone(),
        client_job_id: ctx.client_job_id.clone(),
        stage,
        status: stage_status(stage).to_string(),
        progress: progress.clamp(0.0, 1.0),
        message: detail.into(),
        output_path: output_path.map(|path| path.display().to_string()),
        output_dir: Some(output_root.display().to_string()),
        source_url: resolve_source_url(ctx),
        mpd_url: Some(ctx.request.mpd_url.clone()),
    };
    writer.send(&event)
}

fn resolve_source_url(ctx: &JobContext) -> Option<String> {
    ctx.request
        .source_url
        .clone()
        .or_else(|| ctx.request.metadata.source_url.clone())
        .or_else(|| ctx.request.metadata.manifest_url.clone())
}

fn stage_status(stage: JobStage) -> &'static str {
    match stage {
        JobStage::Waiting => "waiting",
        JobStage::Queued => "queued",
        JobStage::Preparing => "preparing",
        JobStage::Downloading => "downloading",
        JobStage::Decrypting => "decrypting",
        JobStage::Muxing => "muxing",
        JobStage::Cancelling => "cancelling",
        JobStage::Completed => "completed",
        JobStage::Cancelled => "cancelled",
        JobStage::Failed => "failed",
    }
}

#[derive(Serialize, Deserialize)]
struct JobRecord {
    job_id: String,
    client_job_id: Option<String>,
    status: String,
    success: bool,
    output_path: Option<String>,
    output_dir: Option<String>,
    source_url: Option<String>,
    mpd_url: String,
    completed_at: u64,
}

fn persist_job_record(
    config: &HostConfig,
    ctx: &JobContext,
    output_path: Option<&Path>,
    success: bool,
) -> Result<()> {
    let mut records = load_job_records(&config.state_file);
    records.push(JobRecord {
        job_id: ctx.job_id.clone(),
        client_job_id: ctx.client_job_id.clone(),
        status: if success {
            "completed".into()
        } else {
            "failed".into()
        },
        success,
        output_path: output_path.map(|path| path.display().to_string()),
        output_dir: Some(job_output_root(ctx, config).display().to_string()),
        source_url: resolve_source_url(ctx),
        mpd_url: ctx.request.mpd_url.clone(),
        completed_at: now_secs(),
    });
    if records.len() > 20 {
        records.drain(0..records.len() - 20);
    }
    let json = serde_json::to_string_pretty(&records)?;
    if let Some(parent) = config.state_file.parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&config.state_file, json).with_context(|| {
        format!(
            "ジョブログの書き込みに失敗しました: {}",
            config.state_file.display()
        )
    })?;
    Ok(())
}

fn load_job_records(path: &Path) -> Vec<JobRecord> {
    if let Ok(contents) = fs::read_to_string(path) {
        serde_json::from_str(&contents).unwrap_or_default()
    } else {
        Vec::new()
    }
}

fn resolve_binary(var: &str, fallback: &str) -> Result<PathBuf> {
    if let Ok(value) = env::var(var) {
        return Ok(PathBuf::from(value));
    }
    for candidate in fallback_binary_paths(fallback) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    if let Ok(path) = which::which(fallback) {
        return Ok(path);
    }
    Err(anyhow!(
        "{fallback} が PATH 上に見つかりません。環境変数 {var} で絶対パスを指定してください"
    ))
}

/// 環境変数から真偽値を読み取り、1/true/on などの文字列を true として扱います。
fn env_flag(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| interpret_flag(&value, default))
        .unwrap_or(default)
}

fn interpret_flag(value: &str, default: bool) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return default;
    }
    matches!(
        trimmed,
        "1" | "true" | "TRUE" | "True" | "on" | "ON" | "On" | "enable" | "ENABLE"
    )
}

fn fallback_binary_paths(name: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(home) = env::var("HOME") {
        paths.push(PathBuf::from(&home).join(".local/bin").join(name));
        paths.push(PathBuf::from(&home).join("bin").join(name));
    }
    paths.push(PathBuf::from("/usr/local/bin").join(name));
    paths.push(PathBuf::from("/opt/homebrew/bin").join(name));
    paths.push(PathBuf::from("/usr/bin").join(name));
    paths.push(PathBuf::from("/bin").join(name));
    paths
}

fn header_value(headers: &HashMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

/// ネイティブメッセージング形式で JSON を標準出力に書き出します (セルフテスト用)。
fn write_message<T>(value: &T) -> Result<()>
where
    T: Serialize,
{
    let mut stdout = io::stdout().lock();
    let bytes = serde_json::to_vec(value).context("JSON へのシリアライズに失敗しました")?;
    let length = bytes.len() as u32;
    stdout
        .write_all(&length.to_le_bytes())
        .context("メッセージ長の書き込みに失敗しました")?;
    stdout
        .write_all(&bytes)
        .context("メッセージ本体の書き込みに失敗しました")?;
    stdout
        .flush()
        .context("標準出力のフラッシュに失敗しました")?;
    Ok(())
}

/// ログファイルにイベントを書き出します。
fn log_event(message: impl AsRef<str>) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let mut targets: Vec<PathBuf> = Vec::new();
    targets.push(PathBuf::from("/Library/WidevineProxy2/native-host.log"));
    if let Ok(home) = env::var("HOME") {
        let home_path = PathBuf::from(home).join("Library/Logs/WidevineProxy2/native-host.log");
        targets.push(home_path);
    }
    targets.push(PathBuf::from("/tmp/widevineproxy2-native-host.log"));

    for target in targets {
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&target) {
            let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
            break;
        }
    }
}
