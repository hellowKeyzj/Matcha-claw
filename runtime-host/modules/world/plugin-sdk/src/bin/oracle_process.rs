fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let result = match runtime {
        Ok(runtime) => {
            let result = runtime.block_on(world_plugin_sdk::process::run_oracle_stdio());
            runtime.shutdown_background();
            result
        }
        Err(_) => Err(world_plugin_sdk::protocol::process::ProcessFailure::InternalFault),
    };
    if let Err(failure) = result {
        eprintln!("world oracle process: {failure:?}");
        std::process::exit(1);
    }
}
