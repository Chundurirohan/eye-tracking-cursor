// Throwaway probe: what does this compositor's EIS actually offer?
// Run: cargo run --example eis_probe   (a portal consent dialog will appear)
use ashpd::desktop::{
    remote_desktop::{ConnectToEISOptions, DeviceType, RemoteDesktop, SelectDevicesOptions, StartOptions},
    CreateSessionOptions, PersistMode,
};
use futures_util::StreamExt;
use reis::{ei, tokio::EiEventStream, PendingRequestResult};
use std::os::unix::net::UnixStream;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let rd = RemoteDesktop::new().await.expect("RemoteDesktop portal");
    println!("portal AvailableDeviceTypes = {:?}", rd.available_device_types().await);
    let session = rd.create_session(CreateSessionOptions::default()).await.expect("create_session");
    rd.select_devices(
        &session,
        SelectDevicesOptions::default()
            .set_devices(DeviceType::Keyboard | DeviceType::Pointer)
            .set_persist_mode(PersistMode::ExplicitlyRevoked),
    )
    .await
    .expect("select_devices");
    println!("starting (consent dialog)…");
    let started = rd.start(&session, None, StartOptions::default()).await.expect("start").response().expect("response");
    println!("started: devices={:?} restore_token={}", started.devices(), started.restore_token().is_some());
    let fd = rd.connect_to_eis(&session, ConnectToEISOptions::default()).await.expect("connect_to_eis");
    let ctx = ei::Context::new(UnixStream::from(fd)).expect("ei ctx");
    let mut events = EiEventStream::new(ctx.clone()).expect("stream");
    let hs = reis::tokio::ei_handshake(&mut events, "gaze-probe", ei::handshake::ContextType::Sender).await.expect("handshake");
    let conn = hs.connection;
    let mut deadline = std::pin::pin!(tokio::time::sleep(std::time::Duration::from_secs(4)));
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            ev = events.next() => {
                let Some(Ok(PendingRequestResult::Request(ev))) = ev else { continue };
                match ev {
                    ei::Event::Connection(_, ei::connection::Event::Seat { seat }) => { println!("seat"); let _ = seat; }
                    ei::Event::Seat(seat, ei::seat::Event::Capability { mask, interface }) => println!("  seat cap {interface} mask={mask:#x}"),
                    ei::Event::Seat(seat, ei::seat::Event::Done) => { seat.bind(!0); }
                    ei::Event::Device(_, ei::device::Event::Name { name }) => println!("device name={name}"),
                    ei::Event::Device(_, ei::device::Event::DeviceType { device_type }) => println!("  type={device_type:?}"),
                    ei::Event::Device(_, ei::device::Event::Interface { object }) => println!("  iface={}", object.interface()),
                    ei::Event::Device(_, ei::device::Event::Region { offset_x, offset_y, width, hight, scale }) =>
                        println!("  REGION x={offset_x} y={offset_y} w={width} h={hight} scale={scale}"),
                    ei::Event::Connection(_, ei::connection::Event::Ping { ping }) => ping.done(0),
                    _ => {}
                }
                let _ = ctx.flush();
            }
        }
    }
    let _ = conn;
    println!("probe done");
}
