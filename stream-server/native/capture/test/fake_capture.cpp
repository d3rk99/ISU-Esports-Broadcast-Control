// Linux stand-in for isu-capture.exe: same output format (live Matroska, raw NV12 + PCM with
// capture timestamps), produced in real time. Flash + beep at each whole second so A/V sync can be
// measured after the full pipeline. Stops when stdin closes, like the real helper.
#include "../src/mkv_writer.hpp"
#include <chrono>
#include <cmath>
#include <thread>
#include <unistd.h>
#include <fcntl.h>
int main(int argc, char **argv) {
	for (int i = 1; i < argc; ++i) if (std::string(argv[i]) == "--list") { std::puts("{\"video\":[{\"name\":\"Fake Web Presenter\",\"path\":\"fake\",\"audioAttached\":false,\"modes\":[{\"format\":\"NV12\",\"maxWidth\":1280,\"maxHeight\":720,\"minInterval\":166833,\"maxInterval\":166833}]}],\"audio\":[{\"name\":\"Fake Web Presenter Audio\",\"path\":\"fake-a\"}]}"); return 0; }
	fcntl(0, F_SETFL, O_NONBLOCK);
	const int W = 1280, H = 720;
	mkv::VideoTrack v; v.width = W; v.height = H; v.fourcc = "NV12"; v.frameInterval100ns = 166833;
	mkv::AudioTrack a;
	mkv::Writer w(stdout);
	w.header(&v, &a);
	std::vector<uint8_t> frame(W * H * 3 / 2);
	std::vector<int16_t> pcm(480 * 2);
	int64_t vframe = 0, at = 0; // video time from the frame count (exact 60000/1001), like a real clock
	auto t0 = std::chrono::steady_clock::now();
	for (;;) {
		char b; ssize_t r = read(0, &b, 1); if (r == 0) break; // stdin closed
		int64_t now = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - t0).count() / 100;
		bool wrote = false;
		while (at <= now) {
			for (int i = 0; i < 480; ++i) { int64_t t = at + int64_t(i) * 10000000 / 48000; int16_t s = (t % 10000000) < 1000000 ? int16_t(16000 * std::sin(2 * M_PI * 1000 * t / 1e7)) : 0; pcm[i * 2] = pcm[i * 2 + 1] = s; }
			if (!w.frame(false, at, reinterpret_cast<uint8_t *>(pcm.data()), pcm.size() * 2)) return 0;
			at += 100000; wrote = true;
		}
		while (vframe * 1001LL * 10000000LL / 60000LL <= now) {
			const int64_t vt = vframe * 1001LL * 10000000LL / 60000LL;
			bool flash = (vt % 10000000) < 1000000;
			std::fill(frame.begin(), frame.begin() + W * H, flash ? 235 : 16); std::fill(frame.begin() + W * H, frame.end(), 128);
			if (!w.frame(true, vt, frame.data(), frame.size())) return 0;
			++vframe; wrote = true;
		}
		if (wrote) w.flush();
		std::this_thread::sleep_for(std::chrono::milliseconds(2));
	}
	return 0;
}
