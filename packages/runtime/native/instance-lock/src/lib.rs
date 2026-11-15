use napi::{Error, Result, Status};
use napi_derive::napi;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};

const MAX_METADATA: u64 = 4096;

/// 句柄由加载此模块的 Node Runtime 直接持有；Option<File> 同时提供显式关闭与 GC 兜底。
#[napi]
pub struct NativeInstanceLock {
    file: Option<File>,
}

fn io_error(error: std::io::Error) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("instance lock IO failed: {error}"),
    )
}

#[napi]
impl NativeInstanceLock {
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        #[cfg(windows)]
        {
            use std::fs::OpenOptions;
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                DELETE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
            };
            let result = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
                .share_mode(FILE_SHARE_READ)
                .open(path);
            match result {
                Ok(file) => Ok(Self { file: Some(file) }),
                Err(error) if error.raw_os_error() == Some(32) => Err(Error::new(
                    Status::GenericFailure,
                    "MANEKI_INSTANCE_LOCK_BUSY",
                )),
                Err(error) => Err(io_error(error)),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Err(Error::new(
                Status::GenericFailure,
                "instance lock unsupported on this platform",
            ))
        }
    }

    #[napi]
    pub fn read_metadata(&mut self) -> Result<String> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| Error::from_reason("instance lock is closed"))?;
        file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let mut bytes = Vec::new();
        file.take(MAX_METADATA + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() as u64 > MAX_METADATA {
            return Err(Error::from_reason("instance lock metadata exceeds 4 KiB"));
        }
        String::from_utf8(bytes)
            .map_err(|_| Error::from_reason("instance lock metadata is not UTF-8"))
    }

    #[napi]
    pub fn write_metadata(&mut self, metadata: String) -> Result<()> {
        if metadata.len() as u64 > MAX_METADATA {
            return Err(Error::from_reason("instance lock metadata exceeds 4 KiB"));
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| Error::from_reason("instance lock is closed"))?;
        file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        file.set_len(0).map_err(io_error)?;
        file.write_all(metadata.as_bytes()).map_err(io_error)?;
        file.sync_all().map_err(io_error)
    }

    /// 只有已完成取得所有权的 TS 层才传 remove=true；失败路径只关闭自身句柄。
    #[napi]
    pub fn close(&mut self, remove: bool) -> Result<()> {
        if let Some(file) = self.file.as_ref() {
            if remove {
                mark_delete(file)?;
            }
        }
        self.file.take();
        Ok(())
    }
}

#[cfg(windows)]
fn mark_delete(file: &File) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // 在排他句柄仍打开时标删除；不能 close 后按路径 unlink（会删除下一位 owner）。
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            &info as *const FILE_DISPOSITION_INFO as *const _,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn mark_delete(_file: &File) -> Result<()> {
    Err(Error::from_reason(
        "instance lock unsupported on this platform",
    ))
}
