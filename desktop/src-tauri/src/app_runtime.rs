//! Process-wide async runtime bootstrap.

#[cfg(not(feature = "mesh-llm"))]
pub(super) fn install_mesh_runtime() {}

/// Install the larger worker stacks needed by mesh-llm's deep async chains.
#[cfg(feature = "mesh-llm")]
pub(super) fn install_mesh_runtime() {
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(crate::mesh_llm::MESH_WORKER_STACK_SIZE)
        .build()
    {
        Ok(runtime) => {
            tauri::async_runtime::set(runtime.handle().clone());
            // Keep the runtime alive for the process lifetime; dropping it
            // would shut down the workers Tauri now depends on.
            std::mem::forget(runtime);
            eprintln!(
                "buzz-mesh: installed tokio runtime with {} MiB worker stacks",
                crate::mesh_llm::MESH_WORKER_STACK_SIZE / (1024 * 1024)
            );
        }
        Err(error) => {
            // Fall back to Tauri's default runtime: the app still works,
            // only deep mesh-llm futures are at risk of stack overflow.
            eprintln!("buzz-mesh: failed to build big-stack tokio runtime, using default: {error}");
        }
    }
}
