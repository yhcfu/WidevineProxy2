use std::time::Duration;

use anyhow::{Result, anyhow};
use cancel_safe_futures::future::join_then_try;
use criterion::{Criterion, criterion_group, criterion_main};
use tokio::runtime::Runtime;
use tokio::time::sleep;

/**
 * @description tokio::try_join! ベースの処理と cancel-safe-futures 版を比較ベンチします。
 */
fn bench_cancellation(c: &mut Criterion) {
    let rt = Runtime::new().expect("tokio runtime");
    let mut group = c.benchmark_group("cancellation");

    group.bench_function("tokio_try_join", |b| {
        b.to_async(&rt).iter(|| async {
            let _ = run_try_join().await;
        });
    });

    group.bench_function("join_then_try", |b| {
        b.to_async(&rt).iter(|| async {
            let _ = run_join_then_try().await;
        });
    });

    group.finish();
}

/**
 * @description tokio::try_join! を使った協調キャンセルの例です。
 */
async fn run_try_join() -> Result<u64> {
    tokio::try_join!(simulated_job(1, false), simulated_job(2, true))
        .map(|(a, b)| a + b)
        .map_err(|err| anyhow!("try_join failed: {err}"))
}

/**
 * @description cancel-safe-futures::join_then_try! を使った協調キャンセルの例です。
 */
async fn run_join_then_try() -> Result<u64> {
    join_then_try!(simulated_job(1, false), simulated_job(2, true))
        .map(|(a, b)| a + b)
        .map_err(|err| anyhow!("join_then_try failed: {err}"))
}

/**
 * @description 疑似ジョブ。fail=true の場合はエラーを返します。
 */
async fn simulated_job(id: u64, fail: bool) -> Result<u64> {
    sleep(Duration::from_millis(2)).await;
    if fail {
        return Err(anyhow!("job {id} aborted"));
    }
    Ok(id)
}

criterion_group!(name = cancellation; config = Criterion::default(); targets = bench_cancellation);
criterion_main!(cancellation);
