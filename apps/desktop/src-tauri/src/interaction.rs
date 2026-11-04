use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const GRID: usize = 128;
const MASK_BYTES: usize = GRID * GRID / 8;
const LEASE: Duration = Duration::from_secs(2);

#[derive(Clone, Deserialize)]
pub struct Rect {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    radius: f64,
}

impl Rect {
    fn valid(&self) -> bool {
        [self.left, self.top, self.width, self.height, self.radius]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.0 && *v <= 4096.0)
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        if x < self.left
            || y < self.top
            || x >= self.left + self.width
            || y >= self.top + self.height
        {
            return false;
        }
        let radius = self.radius.min(self.width / 2.0).min(self.height / 2.0);
        let cx = x.clamp(self.left + radius, self.left + self.width - radius);
        let cy = y.clamp(self.top + radius, self.top + self.height - radius);
        (x - cx).powi(2) + (y - cy).powi(2) <= radius.powi(2)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitMap {
    pet: Rect,
    mask: Vec<u8>,
    controls: Vec<Rect>,
    pressed: bool,
}

impl HitMap {
    fn pet_contains(&self, x: f64, y: f64) -> bool {
        if !self.pet.contains(x, y) || self.pet.width <= 0.0 || self.pet.height <= 0.0 {
            return false;
        }
        let column = ((x - self.pet.left) / self.pet.width * GRID as f64) as usize;
        let row = ((y - self.pet.top) / self.pet.height * GRID as f64) as usize;
        let index = row.min(GRID - 1) * GRID + column.min(GRID - 1);
        self.mask[index / 8] & (1 << (index % 8)) != 0
    }
}

#[derive(Default)]
pub struct InteractionState(Mutex<Snapshot>);

#[derive(Default)]
struct Snapshot {
    map: Option<HitMap>,
    updated: Option<Instant>,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Hover {
    over_pet: bool,
    over_controls: bool,
    unavailable: bool,
}

impl Snapshot {
    fn hit_test(&self, x: f64, y: f64, manual: bool, now: Instant) -> (bool, Hover) {
        let fresh = self
            .updated
            .is_some_and(|at| now.duration_since(at) < LEASE);
        let map = self.map.as_ref().filter(|_| fresh && !manual);
        let over_pet = map.is_some_and(|map| map.pet_contains(x, y));
        let over_controls =
            map.is_some_and(|map| map.controls.iter().any(|rect| rect.contains(x, y)));
        let pressed = map.is_some_and(|map| map.pressed);
        (
            manual || !(over_pet || over_controls || pressed),
            Hover {
                over_pet,
                over_controls,
                unavailable: self.updated.is_some() && !fresh,
            },
        )
    }
}

#[tauri::command]
pub fn update_hit_map(app: AppHandle, map: HitMap) -> Result<(), String> {
    if map.mask.len() != MASK_BYTES
        || map.controls.len() > 8
        || !map.pet.valid()
        || !map.controls.iter().all(Rect::valid)
    {
        return Err("invalid pet interaction map".into());
    }
    let state = app.state::<InteractionState>();
    let mut snapshot = state.0.lock().map_err(|_| "pet interaction unavailable")?;
    snapshot.map = Some(map);
    snapshot.updated = Some(Instant::now());
    Ok(())
}

/// 原生读取光标，不依赖已穿透窗口继续收到 pointermove；不记录或广播桌面坐标。
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut ignored = false;
        let mut last_hover = None;
        let mut last_emit = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let Some(window) = app.get_webview_window("main") else {
                break;
            };
            let geometry = (
                window.cursor_position(),
                window.inner_position(),
                window.scale_factor(),
            );
            let unavailable = (
                true,
                Hover {
                    over_pet: false,
                    over_controls: false,
                    unavailable: true,
                },
            );
            let (next_ignored, mut hover) = match geometry {
                (Ok(cursor), Ok(origin), Ok(scale)) if scale.is_finite() && scale > 0.0 => {
                    let x = (cursor.x - origin.x as f64) / scale;
                    let y = (cursor.y - origin.y as f64) / scale;
                    let manual = crate::with_settings(&app, |settings| settings.click_through);
                    let state = app.state::<InteractionState>();
                    state
                        .0
                        .lock()
                        .map(|snapshot| snapshot.hit_test(x, y, manual, Instant::now()))
                        .unwrap_or(unavailable)
                }
                _ => unavailable,
            };
            if next_ignored != ignored {
                if window.set_ignore_cursor_events(next_ignored).is_ok() {
                    ignored = next_ignored;
                } else {
                    hover.unavailable = true;
                }
            }
            // 重载后的 WebView 也需拿到当前悬停状态，即使光标没有移动。
            if last_hover != Some(hover) || last_emit.elapsed() >= Duration::from_secs(1) {
                if window.emit("maneki://pointer-region", hover).is_ok() {
                    last_hover = Some(hover);
                    last_emit = Instant::now();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transparent_pixels_and_letterbox_are_not_interactive() {
        let mut map = HitMap {
            pet: Rect {
                left: 10.0,
                top: 20.0,
                width: 128.0,
                height: 128.0,
                radius: 0.0,
            },
            mask: vec![0; MASK_BYTES],
            controls: vec![],
            pressed: false,
        };
        let index = 64 * GRID + 64;
        map.mask[index / 8] |= 1 << (index % 8);
        assert!(map.pet_contains(74.5, 84.5));
        assert!(!map.pet_contains(11.0, 21.0));
        assert!(!map.pet_contains(138.0, 148.0));
        assert!(!map.pet_contains(-10.0, -20.0));
    }

    #[test]
    fn rounded_control_corners_pass_through() {
        let rect = Rect {
            left: 10.0,
            top: 20.0,
            width: 100.0,
            height: 40.0,
            radius: 20.0,
        };
        assert!(rect.contains(60.0, 40.0));
        assert!(!rect.contains(10.1, 20.1));
        assert!(!rect.contains(110.0, 40.0));
        assert!(!Rect {
            width: f64::NAN,
            ..rect
        }
        .valid());
    }

    #[test]
    fn dragging_holds_interaction_but_expired_maps_and_manual_mode_pass_through() {
        let now = Instant::now();
        let snapshot = Snapshot {
            map: Some(HitMap {
                pet: Rect {
                    left: 0.0,
                    top: 0.0,
                    width: 128.0,
                    height: 128.0,
                    radius: 0.0,
                },
                mask: vec![0; MASK_BYTES],
                controls: vec![Rect {
                    left: 0.0,
                    top: 130.0,
                    width: 100.0,
                    height: 40.0,
                    radius: 20.0,
                }],
                pressed: true,
            }),
            updated: Some(now),
        };
        assert!(!snapshot.hit_test(200.0, 200.0, false, now).0);
        assert!(snapshot.hit_test(50.0, 150.0, false, now).1.over_controls);
        assert!(snapshot.hit_test(50.0, 150.0, true, now).0);
        let (ignored, hover) = snapshot.hit_test(50.0, 150.0, false, now + LEASE);
        assert!(ignored);
        assert!(hover.unavailable);
        assert!(!hover.over_controls);
    }
}
