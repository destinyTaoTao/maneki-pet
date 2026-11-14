use std::sync::atomic::{AtomicU64, Ordering};

static GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(all(test, windows))]
static TEST_POWER_EVENTS: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

fn record_power_event(event: u32) {
    // PBT_APMSUSPEND / PBT_APMRESUMESUSPEND / PBT_APMRESUMEAUTOMATIC。
    if matches!(event, 0x0004 | 0x0007 | 0x0012) {
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    #[cfg(all(test, windows))]
    if event == 0x0004 || event == 0x0012 {
        TEST_POWER_EVENTS.fetch_or(if event == 0x0004 { 1 } else { 2 }, Ordering::SeqCst);
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    #[repr(C)]
    struct Subscription {
        callback: extern "system" fn(*mut c_void, u32, *mut c_void) -> u32,
        context: usize,
    }
    extern "system" fn callback(_: *mut c_void, event: u32, _: *mut c_void) -> u32 {
        super::record_power_event(event);
        0
    }
    static SUBSCRIPTION: Subscription = Subscription {
        callback,
        context: 0,
    };
    static REGISTRATION: OnceLock<Result<usize, u32>> = OnceLock::new();
    #[link(name = "PowrProf")]
    extern "system" {
        fn PowerRegisterSuspendResumeNotification(
            flags: u32,
            recipient: *const Subscription,
            handle: *mut *mut c_void,
        ) -> u32;
    }
    pub fn initialize() -> Result<(), u32> {
        match REGISTRATION.get_or_init(|| {
            let mut handle = std::ptr::null_mut();
            // 回调只更新静态原子量；注册和回调均与进程同寿命，系统在进程退出时回收句柄。
            let result =
                unsafe { PowerRegisterSuspendResumeNotification(2, &SUBSCRIPTION, &mut handle) };
            if result == 0 && !handle.is_null() {
                Ok(handle as usize)
            } else {
                Err(result)
            }
        }) {
            Ok(_) => Ok(()),
            Err(code) => Err(*code),
        }
    }
}

pub fn initialize() {
    #[cfg(windows)]
    let _ = windows::initialize();
}

#[tauri::command]
pub fn companion_power_generation() -> Result<u64, String> {
    #[cfg(windows)]
    {
        windows::initialize().map_err(|_| "power_notifications_unavailable".to_string())?;
        Ok(GENERATION.load(Ordering::SeqCst))
    }
    #[cfg(not(windows))]
    {
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suspend_and_resume_advance_generation() {
        let before = GENERATION.load(Ordering::SeqCst);
        record_power_event(0x0004);
        record_power_event(0x0012);
        assert_eq!(GENERATION.load(Ordering::SeqCst), before + 2);
        record_power_event(0x1234);
        assert_eq!(GENERATION.load(Ordering::SeqCst), before + 2);
    }
    #[cfg(windows)]
    #[test]
    fn registers_with_windows_power_service() {
        assert!(windows::initialize().is_ok());
        assert!(companion_power_generation().is_ok());
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "需要人工使电脑真实休眠并唤醒；不可在常规自动测试中执行"]
    fn observes_real_suspend_and_resume() {
        TEST_POWER_EVENTS.store(0, Ordering::SeqCst);
        windows::initialize().expect("电源通知注册失败");
        let baseline = GENERATION.load(Ordering::SeqCst);
        println!("POWER_PROBE_READY: 请让电脑睡眠后唤醒");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        while std::time::Instant::now() < deadline {
            if TEST_POWER_EVENTS.load(Ordering::SeqCst) & 3 == 3 {
                assert!(GENERATION.load(Ordering::SeqCst) >= baseline + 2);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("未在时限内观察到真实挂起和恢复通知");
    }
}
