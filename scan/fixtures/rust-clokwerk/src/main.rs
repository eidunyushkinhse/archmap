use clokwerk::{AsyncScheduler, Interval, Job, TimeUnits};

pub async fn setup(context: Context) {
    let mut scheduler = AsyncScheduler::new();

    scheduler.every(TimeUnits::minutes(5)).run(async move || {
        refresh_cache().await;
    });
    scheduler.every(1.hour()).run(move || {
        let context = context.clone();
        async move {
            update_counts(&context).await;
        }
    });
    scheduler
        .every(Interval::Daily)
        .at("03:00")
        .run(|| cleanup_old_rows());
    scheduler.every(30.seconds()).run(|| async {
        Ok::<(), Error>(())
    });
    // scheduler.every(1.day()).run(|| commented());
}

#[cfg(test)]
mod tests {
    #[test]
    fn schedule() {
        scheduler.every(1.minute()).run(|| from_test());
    }
}
