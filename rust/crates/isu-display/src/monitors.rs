//! Monitor order of display-client-main.cjs: displays() sorted top-to-bottom, then left-to-right
//! (bounds.y, then bounds.x); displayAt(index, fallback) = list[index - 1] || list[fallback] || first.
//! One list for the game mirror, the cursor lock and the audience window placement.

/// One monitor in physical pixels: (left, top, right, bottom) + its handle (HMONITOR on Windows).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mon {
    pub rect: [i32; 4],
    pub handle: isize,
}

/// displays(): sorted by y then x (stable).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn sorted(mut v: Vec<Mon>) -> Vec<Mon> {
    v.sort_by_key(|m| (m.rect[1], m.rect[0]));
    v
}

/// displayAt(index, fallback).
pub fn at(list: &[Mon], index: usize, fallback: usize) -> Option<Mon> {
    index.checked_sub(1).and_then(|i| list.get(i)).or_else(|| list.get(fallback)).or_else(|| list.first()).copied()
}

#[cfg(windows)]
pub fn all() -> Vec<Mon> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Rect { left: i32, top: i32, right: i32, bottom: i32 }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumDisplayMonitors(hdc: *mut c_void, clip: *const Rect, cb: extern "system" fn(*mut c_void, *mut c_void, *mut Rect, isize) -> i32, data: isize) -> i32;
    }
    extern "system" fn cb(m: *mut c_void, _dc: *mut c_void, r: *mut Rect, data: isize) -> i32 {
        let v = unsafe { &mut *(data as *mut Vec<Mon>) };
        let r = unsafe { &*r };
        v.push(Mon { rect: [r.left, r.top, r.right, r.bottom], handle: m as isize });
        1
    }
    let mut v: Vec<Mon> = Vec::new();
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), cb, &mut v as *mut _ as isize) };
    sorted(v)
}

#[cfg(not(windows))]
pub fn all() -> Vec<Mon> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn m(x: i32, y: i32, w: i32, h: i32) -> Mon { Mon { rect: [x, y, x + w, y + h], handle: 0 } }
    #[test]
    fn order_and_fallback_like_js() {
        // Derk's PC: 2560x1440 @ 0,0, 1920x1080 @ -1920,196, 1920x1080 @ 2560,184
        let list = sorted(vec![m(0, 0, 2560, 1440), m(-1920, 196, 1920, 1080), m(2560, 184, 1920, 1080)]);
        assert_eq!(list.iter().map(|x| x.rect[0]).collect::<Vec<_>>(), vec![0, 2560, -1920], "y first, then x");
        assert_eq!(at(&list, 2, 0).unwrap().rect[0], 2560);
        assert_eq!(at(&list, 9, 1).unwrap().rect[0], 2560, "missing index -> fallback");
        assert_eq!(at(&list, 0, 7).unwrap().rect[0], 0, "no fallback -> first");
        assert_eq!(at(&[], 1, 0), None);
    }
}
