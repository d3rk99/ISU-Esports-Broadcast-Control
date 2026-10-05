// Writes 3 s of NV12 video (59.94 fps, white flash at each whole second) + 48 kHz stereo PCM
// (1 kHz beep at the same instants), interleaved slightly out of order like real capture threads.
#include "../src/mkv_writer.hpp"
#include <cmath>
int main() {
	const int W = 320, H = 180;
	mkv::VideoTrack v; v.width = W; v.height = H; v.fourcc = "NV12"; v.frameInterval100ns = 166833;
	mkv::AudioTrack a;
	mkv::Writer w(stdout);
	if (!w.header(&v, &a)) return 1;
	std::vector<uint8_t> frame(W * H * 3 / 2);
	std::vector<int16_t> pcm(480 * 2); // 10 ms
	int64_t vt = 0, at = 0;
	const int64_t vdur = 166833, adur = 100000;
	while (vt < 30000000 || at < 30000000) {
		// whichever is behind goes next, but audio is allowed to run up to 40 ms ahead
		if (at <= vt + 400000 && at < 30000000) {
			for (int i = 0; i < 480; ++i) {
				int64_t t = at + int64_t(i) * 10000000 / 48000;
				bool beep = (t % 10000000) < 1000000;
				int16_t s = beep ? int16_t(16000 * std::sin(2 * M_PI * 1000 * t / 1e7)) : 0;
				pcm[i * 2] = pcm[i * 2 + 1] = s;
			}
			w.frame(false, at, reinterpret_cast<uint8_t *>(pcm.data()), pcm.size() * 2);
			at += adur;
		} else {
			bool flash = (vt % 10000000) < 1000000;
			std::fill(frame.begin(), frame.begin() + W * H, flash ? 235 : 16);
			std::fill(frame.begin() + W * H, frame.end(), 128);
			w.frame(true, vt, frame.data(), frame.size());
			vt += vdur;
		}
	}
	w.flush();
	return 0;
}
