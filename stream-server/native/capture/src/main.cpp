// isu-capture: OBS-grade DirectShow capture for ISU Stream Server.
//
// Uses OBS's libdshowcapture (LGPL-2.1, linked as libdshowcapture.dll, unmodified) to open a video
// device and its audio exactly the way OBS's "Video Capture Device" source does:
//   - video + audio in ONE DirectShow graph (one reference clock)
//   - every sample keeps its own capture start time (100 ns)
//   - small audio buffers (10 ms, like OBS) so audio never arrives in late lumps
// Raw frames + PCM are written to stdout as a live Matroska stream with those timestamps, so the
// FFmpeg program encoder (-f matroska -i pipe:0) keeps them in sync. Nothing is encoded here.
//
//   isu-capture --list                         JSON list of video + audio devices with modes
//   isu-capture --video "<name or path>" [--audio "<name>"|--device-audio] [--size WxH]
//               [--fps 59.94] [--format NV12|YUY2|UYVY|I420|YV12|MJPEG|ARGB|XRGB] [--audio-buffer 10]
//
// Logs go to stderr as single lines ("isu-capture: ..."). Exit code != 0 = could not start.
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <ocidl.h>
#include "dshowcapture.hpp"
#include "mkv_writer.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <fcntl.h>
#include <io.h>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace DShow;

static std::string utf8(const std::wstring &w) {
	if (w.empty()) return {};
	int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), int(w.size()), nullptr, 0, nullptr, nullptr);
	std::string s(n, '\0');
	WideCharToMultiByte(CP_UTF8, 0, w.c_str(), int(w.size()), s.data(), n, nullptr, nullptr);
	return s;
}
static std::wstring wide(const std::string &s) {
	if (s.empty()) return {};
	int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), int(s.size()), nullptr, 0);
	std::wstring w(n, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, s.c_str(), int(s.size()), w.data(), n);
	return w;
}
static std::string json(const std::string &s) {
	std::string o = "\"";
	for (unsigned char c : s) {
		if (c == '"' || c == '\\') { o += '\\'; o += char(c); }
		else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
		else o += char(c);
	}
	return o + "\"";
}
static void log(const char *fmt, const std::string &a = "") { std::fprintf(stderr, "isu-capture: "); std::fprintf(stderr, fmt, a.c_str()); std::fprintf(stderr, "\n"); std::fflush(stderr); }

// FFmpeg lists DirectShow devices by moniker display name ("@device_cm_{...}\wave_{...}",
// "@device_pnp_..."). libdshowcapture only knows friendly names and device paths, so turn a moniker
// name into its FriendlyName (and DevicePath when it has one) before matching.
static bool monikerInfo(const std::string &id, std::wstring &friendly, std::wstring &devicePath) {
	if (id.rfind("@device", 0) != 0) return false;
	IBindCtx *ctx = nullptr;
	if (FAILED(CreateBindCtx(0, &ctx))) return false;
	IMoniker *mon = nullptr;
	ULONG eaten = 0;
	std::wstring wid = wide(id);
	HRESULT hr = MkParseDisplayName(ctx, wid.c_str(), &eaten, &mon);
	bool ok = false;
	if (SUCCEEDED(hr) && mon) {
		IPropertyBag *bag = nullptr;
		if (SUCCEEDED(mon->BindToStorage(ctx, nullptr, IID_IPropertyBag, reinterpret_cast<void **>(&bag))) && bag) {
			VARIANT v; VariantInit(&v);
			if (SUCCEEDED(bag->Read(L"FriendlyName", &v, nullptr)) && v.vt == VT_BSTR) { friendly = v.bstrVal; ok = true; }
			VariantClear(&v);
			VariantInit(&v);
			if (SUCCEEDED(bag->Read(L"DevicePath", &v, nullptr)) && v.vt == VT_BSTR) devicePath = v.bstrVal;
			VariantClear(&v);
			bag->Release();
		}
		mon->Release();
	}
	ctx->Release();
	return ok;
}

// Match by path, then friendly name, then moniker id (resolved to path/name).
template <typename T> static const T *findDevice(const std::vector<T> &list, const std::string &arg) {
	for (const auto &d : list) if (!d.path.empty() && utf8(d.path) == arg) return &d;
	for (const auto &d : list) if (utf8(d.name) == arg) return &d;
	std::wstring friendly, path;
	if (monikerInfo(arg, friendly, path)) {
		for (const auto &d : list) if (!path.empty() && d.path == path) return &d;
		for (const auto &d : list) if (d.name == friendly) return &d;
	}
	return nullptr;
}

static const char *formatName(VideoFormat f) {
	switch (f) {
	case VideoFormat::ARGB: return "ARGB"; case VideoFormat::XRGB: return "XRGB";
	case VideoFormat::I420: return "I420"; case VideoFormat::NV12: return "NV12";
	case VideoFormat::YV12: return "YV12"; case VideoFormat::Y800: return "Y800";
	case VideoFormat::P010: return "P010"; case VideoFormat::YVYU: return "YVYU";
	case VideoFormat::YUY2: return "YUY2"; case VideoFormat::UYVY: return "UYVY";
	case VideoFormat::HDYC: return "HDYC"; case VideoFormat::MJPEG: return "MJPEG";
	case VideoFormat::H264: return "H264"; case VideoFormat::HEVC: return "HEVC";
	default: return "Any";
	}
}
static VideoFormat parseFormat(const std::string &s) {
	for (VideoFormat f : {VideoFormat::NV12, VideoFormat::YUY2, VideoFormat::UYVY, VideoFormat::I420, VideoFormat::YV12,
			      VideoFormat::MJPEG, VideoFormat::ARGB, VideoFormat::XRGB, VideoFormat::HDYC, VideoFormat::YVYU})
		if (_stricmp(s.c_str(), formatName(f)) == 0) return f;
	return VideoFormat::Any;
}
// Matroska V_UNCOMPRESSED FourCC FFmpeg understands for each raw format.
static const char *fourcc(VideoFormat f) {
	switch (f) {
	case VideoFormat::NV12: return "NV12"; case VideoFormat::YUY2: return "YUY2";
	case VideoFormat::UYVY: case VideoFormat::HDYC: return "UYVY"; case VideoFormat::YVYU: return "YVYU";
	case VideoFormat::I420: return "I420"; case VideoFormat::YV12: return "YV12";
	case VideoFormat::ARGB: case VideoFormat::XRGB: return "BGRA";
	default: return nullptr;
	}
}

static int listDevices() {
	std::vector<VideoDevice> vids;
	std::vector<AudioDevice> auds;
	Device::EnumVideoDevices(vids);
	Device::EnumAudioDevices(auds);
	std::string o = "{\"video\":[";
	for (size_t i = 0; i < vids.size(); ++i) {
		const auto &d = vids[i];
		o += (i ? "," : "") + std::string("{\"name\":") + json(utf8(d.name)) + ",\"path\":" + json(utf8(d.path)) +
		     ",\"audioAttached\":" + (d.audioAttached ? "true" : "false") + ",\"modes\":[";
		for (size_t k = 0; k < d.caps.size(); ++k) {
			const auto &c = d.caps[k];
			char b[256];
			std::snprintf(b, sizeof b, "%s{\"format\":\"%s\",\"maxWidth\":%d,\"maxHeight\":%d,\"minInterval\":%lld,\"maxInterval\":%lld}",
				      k ? "," : "", formatName(c.format), c.maxCX, c.maxCY, c.minInterval, c.maxInterval);
			o += b;
		}
		o += "]}";
	}
	o += "],\"audio\":[";
	for (size_t i = 0; i < auds.size(); ++i)
		o += (i ? "," : "") + std::string("{\"name\":") + json(utf8(auds[i].name)) + ",\"path\":" + json(utf8(auds[i].path)) + "}";
	o += "]}\n";
	std::fwrite(o.data(), 1, o.size(), stdout);
	return 0;
}

// Samples from the DirectShow threads are queued and written in timestamp order by one writer
// thread, so video/audio interleave correctly in the stream (bounded: drop oldest if the pipe stalls).
struct Sample { bool video; long long ts; std::vector<uint8_t> data; };
static std::mutex qm;
static std::condition_variable qcv;
static std::deque<Sample> q;
static size_t qBytes = 0;
static std::atomic<bool> running{true};
static std::atomic<uint64_t> droppedSamples{0};
static const size_t MAX_QUEUE = 512ull * 1024 * 1024;

static void push(bool video, long long ts, const unsigned char *data, size_t size) {
	std::lock_guard<std::mutex> lk(qm);
	while (qBytes + size > MAX_QUEUE && !q.empty()) { qBytes -= q.front().data.size(); q.pop_front(); ++droppedSamples; }
	q.push_back({video, ts, std::vector<uint8_t>(data, data + size)});
	qBytes += size;
	qcv.notify_one();
}

static std::atomic<bool> outputConnected{false};
static void requestStop() {
	running = false;
	qcv.notify_all();
	if (!outputConnected) std::_Exit(0); // still waiting for the encoder to connect: nothing to flush
}
static BOOL WINAPI onCtrl(DWORD) { requestStop(); return TRUE; }

int main(int argc, char **argv) {
	_setmode(_fileno(stdout), _O_BINARY);
	std::string videoArg, audioArg, size, format = "", fpsArg;
	std::string pipeName;
	bool list = false, deviceAudio = false, testPattern = false;
	int audioBuffer = 10;
	DWORD parentPid = 0;
	for (int i = 1; i < argc; ++i) {
		std::string a = argv[i];
		auto next = [&]() { return i + 1 < argc ? std::string(argv[++i]) : std::string(); };
		if (a == "--list") list = true;
		else if (a == "--video") videoArg = next();
		else if (a == "--audio") audioArg = next();
		else if (a == "--device-audio") deviceAudio = true;
		else if (a == "--size") size = next();
		else if (a == "--fps") fpsArg = next();
		else if (a == "--format") format = next();
		else if (a == "--audio-buffer") audioBuffer = std::max(1, std::min(500, std::atoi(next().c_str())));
		else if (a == "--pipe") pipeName = next();
		else if (a == "--parent-pid") parentPid = DWORD(std::strtoul(next().c_str(), nullptr, 10));
		else if (a == "--test-pattern") testPattern = true;
	}
	CoInitializeEx(nullptr, COINIT_MULTITHREADED);
	SetLogCallback([](LogType t, const wchar_t *m, void *) { if (t <= LogType::Warning) log("dshow: %s", utf8(m)); }, nullptr);
	if (list) return listDevices();
	if (videoArg.empty() && !testPattern) { log("%s", "missing --video"); return 2; }
	SetConsoleCtrlHandler(onCtrl, TRUE);
	// Stop when the parent closes our stdin (normal stop) or the parent process dies. Only a clean EOF
	// or a broken pipe counts: any other stdin read error must never stop a live capture.
	std::thread([]() {
		HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
		if (!in || in == INVALID_HANDLE_VALUE) return;
		char b[64]; DWORD n = 0;
		for (;;) {
			if (ReadFile(in, b, sizeof b, &n, nullptr)) { if (n == 0) break; continue; }
			if (GetLastError() == ERROR_BROKEN_PIPE) break;
			return;
		}
		requestStop();
	}).detach();
	if (parentPid) std::thread([parentPid]() {
		HANDLE p = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
		if (!p) return;
		WaitForSingleObject(p, INFINITE);
		CloseHandle(p);
		requestStop();
	}).detach();

	// Output: a synchronous Windows named pipe that FFmpeg opens by name (-i \\.\pipe\...).
	// Handing FFmpeg a pipe created by Node does not work on Windows (overlapped handle -> FFmpeg
	// "I/O error"), so the data path is helper -> named pipe -> FFmpeg with nothing in between.
	FILE *outFile = stdout;
	if (!pipeName.empty()) {
		HANDLE h = CreateNamedPipeW(wide(pipeName).c_str(), PIPE_ACCESS_OUTBOUND, PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 8 * 1024 * 1024, 0, 0, nullptr);
		if (h == INVALID_HANDLE_VALUE) { log("could not create the output pipe %s", pipeName); return 9; }
		log("%s", "pipe ready");
		if (!ConnectNamedPipe(h, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) { log("%s", "the encoder never opened the pipe"); return 10; }
		outputConnected = true;
		int fd = _open_osfhandle(reinterpret_cast<intptr_t>(h), 0);
		outFile = fd >= 0 ? _fdopen(fd, "wb") : nullptr;
		if (!outFile) { log("%s", "could not open the output pipe"); return 11; }
	}
	outputConnected = true;
	std::setvbuf(outFile, nullptr, _IOFBF, 4 * 1024 * 1024);

	mkv::Writer writer(outFile);
	std::atomic<bool> headerDone{false};
	std::mutex hm;
	VideoFormat gotFormat = VideoFormat::Any;
	int gotW = 0, gotH = 0;
	long long gotInterval = 0;
	int aRate = 0, aCh = 0, aBits = 16;
	bool aFloat = false, haveAudio = false;
	long long t0 = -1;
	std::mutex t0m;
	auto rel = [&](long long ts) { std::lock_guard<std::mutex> lk(t0m); if (t0 < 0) t0 = ts; return ts - t0; };
	Device dev(InitGraph::True);
	VideoConfig vc;
	AudioConfig ac;
	std::thread gen;

	if (testPattern) {
		// Built-in source for testing the whole helper -> encoder path without a device: 1280x720 NV12
		// at 59.94 fps that flashes white at each whole second + a 1 kHz beep at the same instants.
		gotFormat = VideoFormat::NV12; gotW = 1280; gotH = 720; gotInterval = 166833;
		aRate = 48000; aCh = 2; aBits = 16; haveAudio = true;
		gen = std::thread([]() {
			const int W = 1280, H = 720;
			std::vector<unsigned char> frame(W * H * 3 / 2);
			std::vector<int16_t> pcm(480 * 2);
			const auto start = std::chrono::steady_clock::now();
			long long vf = 0, at = 0;
			while (running) {
				const long long now = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start).count() / 100;
				while (at <= now) {
					for (int i = 0; i < 480; ++i) {
						const long long t = at + (long long)i * 10000000 / 48000;
						const int16_t v = (t % 10000000) < 1000000 ? int16_t(16000 * std::sin(2 * 3.14159265358979 * 1000.0 * t / 1e7)) : 0;
						pcm[i * 2] = pcm[i * 2 + 1] = v;
					}
					push(false, at, reinterpret_cast<unsigned char *>(pcm.data()), pcm.size() * 2);
					at += 100000;
				}
				while (vf * 1001LL * 10000000LL / 60000LL <= now) {
					const long long vt = vf * 1001LL * 10000000LL / 60000LL;
					const bool flash = (vt % 10000000) < 1000000;
					std::fill(frame.begin(), frame.begin() + W * H, (unsigned char)(flash ? 235 : 16));
					std::fill(frame.begin() + W * H, frame.end(), (unsigned char)128);
					push(true, vt, frame.data(), frame.size());
					++vf;
				}
				Sleep(2);
			}
		});
		log("%s", "capturing built-in test pattern");
	} else {
	// Match the video device by path, then by name (same rules OBS uses for its device id).
	std::vector<VideoDevice> vids;
	Device::EnumVideoDevices(vids);
	const VideoDevice *vd = findDevice(vids, videoArg);
	if (!vd) { log("video device not found: %s (run isu-capture --list to see the names)", videoArg); return 3; }

	vc.name = vd->name;
	vc.path = vd->path;
	vc.useDefaultConfig = size.empty() && format.empty() && fpsArg.empty();
	if (!size.empty()) std::sscanf(size.c_str(), "%dx%d", &vc.cx, &vc.cy_abs);
	if (!fpsArg.empty()) {
		// 100 ns frame interval. NTSC rates are N*1000/1001 fps exactly: 59.94 -> 10000000*1001/60000.
		double fps = std::atof(fpsArg.c_str());
		vc.frameInterval = fps > 0 ? (long long)(10000000.0 / fps + 0.5) : 0;
		for (int base : {24, 30, 60, 120})
			if (std::abs(fps - base * 1000.0 / 1001.0) < 0.01) vc.frameInterval = (long long)(10000000.0 * 1001.0 / (base * 1000.0) + 0.5);
	}
	vc.internalFormat = vc.format = parseFormat(format);

	vc.callback = [&](const VideoConfig &c, unsigned char *data, size_t sz, long long start, long long, long) {
		if (!headerDone) { std::lock_guard<std::mutex> lk(hm); gotFormat = c.format; gotW = c.cx; gotH = c.cy_abs; gotInterval = c.frameInterval; }
		long long r = rel(start);
		if (r >= 0) push(true, r, data, sz);
	};
	if (!dev.SetVideoConfig(&vc)) { log("%s", "could not configure the video device (mode not supported?)"); return 4; }

	if (deviceAudio || !audioArg.empty()) {
		std::vector<AudioDevice> auds;
		Device::EnumAudioDevices(auds);
		if (deviceAudio) {
			ac.useVideoDevice = !vd->separateAudioFilter;
			ac.useSeparateAudioFilter = vd->separateAudioFilter;
		} else {
			const AudioDevice *ad = findDevice(auds, audioArg);
			if (!ad) {
				std::string names;
				for (const auto &d : auds) names += (names.empty() ? "" : ", ") + utf8(d.name);
				log("audio device not found: %s", audioArg + " (audio devices: " + (names.empty() ? "none" : names) + ")");
				return 5;
			}
			ac.name = ad->name;
			ac.path = ad->path;
		}
		ac.mode = AudioMode::Capture;
		ac.buffer = audioBuffer; // ms; OBS asks for 10
		ac.callback = [&](const AudioConfig &c, unsigned char *data, size_t sz, long long start, long long) {
			if (!headerDone) { std::lock_guard<std::mutex> lk(hm); aRate = c.sampleRate; aCh = c.channels; aFloat = c.format == AudioFormat::WaveFloat; aBits = aFloat ? 32 : 16; }
			long long r = rel(start);
			if (r >= 0) push(false, r, data, sz);
		};
		haveAudio = dev.SetAudioConfig(&ac);
		if (!haveAudio) log("%s", "audio device could not be configured; continuing with video only");
	}

	if (!dev.ConnectFilters()) { log("%s", "could not connect the DirectShow filters"); return 6; }
	Result r = dev.Start();
	if (r == Result::InUse) { log("%s", "the device is in use by another program (close OBS / the other app)"); return 7; }
	if (r != Result::Success) { log("%s", "could not start capture"); return 8; }
	} // device

	// Writer: wait for the first video frame (and audio when expected) to learn the real formats,
	// then emit the header and stream samples in timestamp order with a small reorder window.
	const long long REORDER = 1500000; // 150 ms: absorbs DirectShow thread jitter between pins
	std::thread out([&]() {
		std::vector<Sample> pending;
		auto start = GetTickCount64();
		for (;;) {
			std::unique_lock<std::mutex> lk(qm);
			qcv.wait_for(lk, std::chrono::milliseconds(20));
			while (!q.empty()) { qBytes -= q.front().data.size(); pending.push_back(std::move(q.front())); q.pop_front(); }
			lk.unlock();
			if (!running && pending.empty()) break;
			if (!headerDone) {
				bool v = false, a = false;
				for (auto &s : pending) (s.video ? v : a) = true;
				bool waitAudio = haveAudio && !a && GetTickCount64() - start < 3000;
				if (!v || waitAudio) continue;
				const char *fcc = fourcc(gotFormat);
				if (!fcc && gotFormat != VideoFormat::MJPEG) { log("unsupported device format %s; pick NV12/YUY2/UYVY/MJPEG", formatName(gotFormat)); running = false; break; }
				mkv::VideoTrack vt; vt.width = gotW; vt.height = gotH; vt.frameInterval100ns = gotInterval;
				if (gotFormat == VideoFormat::MJPEG) vt.codec = "V_MJPEG"; else vt.fourcc = fcc;
				mkv::AudioTrack at; at.sampleRate = aRate ? aRate : 48000; at.channels = aCh ? aCh : 2; at.bits = aBits; at.isFloat = aFloat;
				if (!writer.header(&vt, haveAudio && a ? &at : nullptr)) { running = false; break; }
				char info[160];
				std::snprintf(info, sizeof info, "%dx%d %s %.3f fps, audio %s", gotW, gotH, formatName(gotFormat), gotInterval ? 1e7 / gotInterval : 0.0, haveAudio && a ? "on" : "off");
				log("capturing %s", info);
				headerDone = true;
			}
			std::stable_sort(pending.begin(), pending.end(), [](const Sample &x, const Sample &y) { return x.ts < y.ts; });
			long long newest = pending.empty() ? 0 : pending.back().ts;
			size_t n = 0;
			for (; n < pending.size(); ++n) {
				if (running && newest - pending[n].ts < REORDER) break;
				if (!writer.frame(pending[n].video, pending[n].ts, pending[n].data.data(), pending[n].data.size())) { running = false; break; }
			}
			pending.erase(pending.begin(), pending.begin() + n);
			writer.flush();
		}
	});
	while (running) Sleep(100);
	if (gen.joinable()) gen.join();
	else dev.Stop();
	out.join();
	std::fclose(outFile); // EOF tells FFmpeg the capture ended
	if (droppedSamples) log("dropped %s samples because the encoder fell behind", std::to_string(droppedSamples.load()));
	CoUninitialize();
	return 0;
}
