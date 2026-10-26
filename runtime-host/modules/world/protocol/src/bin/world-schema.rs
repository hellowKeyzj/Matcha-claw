use std::io::{self, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = world_protocol::schema::public_api()?;
    let mut output = io::stdout().lock();
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    Ok(())
}
