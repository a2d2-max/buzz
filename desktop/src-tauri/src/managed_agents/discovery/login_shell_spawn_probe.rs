//! Test-only counter for login-shell spawn attempts.
//!
//! `run_in_login_shell` is the single subprocess-spawning step on the
//! absent-command resolution path, so counting its calls proves whether a
//! cheap discovery re-spawns after a negative resolution was cached.

use std::cell::Cell;

thread_local! {
    /// Tests run in parallel, so an unrelated resolver on another test thread
    /// must not be charged to the cheap-discovery call under observation.
    static COUNT: Cell<usize> = const { Cell::new(0) };
}

pub(crate) fn record() {
    COUNT.with(|count| count.set(count.get() + 1));
}

pub(crate) fn reset() {
    COUNT.with(|count| count.set(0));
}

pub(crate) fn count() -> usize {
    COUNT.with(Cell::get)
}

#[test]
fn parallel_test_threads_do_not_pollute_the_probe() {
    reset();
    std::thread::spawn(record).join().expect("probe thread");
    assert_eq!(count(), 0);
    record();
    assert_eq!(count(), 1);
}
