// Minimal live Matroska writer: one video + one audio track of RAW media with exact capture
// timestamps. Segment and clusters use "unknown size" so it can be streamed through a pipe
// (FFmpeg's matroska demuxer reads it live). Timestamps: 100 ns in, TimestampScale 100 us.
#pragma once
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace mkv {

using Bytes = std::vector<uint8_t>;

inline void id(Bytes &b, uint32_t v) {
	if (v >= 0x1000000) b.push_back(uint8_t(v >> 24));
	if (v >= 0x10000) b.push_back(uint8_t(v >> 16));
	if (v >= 0x100) b.push_back(uint8_t(v >> 8));
	b.push_back(uint8_t(v));
}
inline void size8(Bytes &b, uint64_t v) { // always 8-byte EBML size
	b.push_back(0x01);
	for (int i = 6; i >= 0; --i) b.push_back(uint8_t(v >> (8 * i)));
}
inline void unknownSize(Bytes &b) {
	b.push_back(0x01);
	for (int i = 0; i < 7; ++i) b.push_back(0xff);
}
inline void uint(Bytes &b, uint32_t eid, uint64_t v) {
	uint8_t t[8];
	int n = 0;
	do { t[n++] = uint8_t(v); v >>= 8; } while (v);
	id(b, eid);
	b.push_back(uint8_t(0x80 | n));
	for (int i = n - 1; i >= 0; --i) b.push_back(t[i]);
}
inline void flt(Bytes &b, uint32_t eid, double v) {
	uint64_t u;
	std::memcpy(&u, &v, 8);
	id(b, eid);
	b.push_back(0x88);
	for (int i = 7; i >= 0; --i) b.push_back(uint8_t(u >> (8 * i)));
}
inline void bin(Bytes &b, uint32_t eid, const void *p, size_t n) {
	id(b, eid);
	size8(b, n);
	const uint8_t *c = static_cast<const uint8_t *>(p);
	b.insert(b.end(), c, c + n);
}
inline void str(Bytes &b, uint32_t eid, const std::string &s) { bin(b, eid, s.data(), s.size()); }
inline void master(Bytes &b, uint32_t eid, const Bytes &child) {
	id(b, eid);
	size8(b, child.size());
	b.insert(b.end(), child.begin(), child.end());
}

struct VideoTrack {
	int width = 0, height = 0;
	std::string codec = "V_UNCOMPRESSED"; // or V_MJPEG
	std::string fourcc;                   // for V_UNCOMPRESSED: NV12, YUY2, UYVY, I420, YV12, BGRA...
	int64_t frameInterval100ns = 0;      // 0 = unknown
};
struct AudioTrack {
	int sampleRate = 48000, channels = 2, bits = 16;
	bool isFloat = false;
};

class Writer {
public:
	explicit Writer(FILE *out) : out_(out) {}

	// Tracks: video = 1 (if any), audio = next number.
	bool header(const VideoTrack *v, const AudioTrack *a) {
		Bytes b, ebml, info, tracks;
		uint(ebml, 0x4286, 1); uint(ebml, 0x42F7, 1); uint(ebml, 0x42F2, 4); uint(ebml, 0x42F3, 8);
		str(ebml, 0x4282, "matroska"); uint(ebml, 0x4287, 4); uint(ebml, 0x4285, 2);
		master(b, 0x1A45DFA3, ebml);
		id(b, 0x18538067); unknownSize(b); // Segment
		uint(info, 0x2AD7B1, 100000); // 100 us per tick
		str(info, 0x4D80, "isu-capture"); str(info, 0x5741, "isu-capture");
		master(b, 0x1549A966, info);
		int n = 0;
		if (v) {
			Bytes t, vid;
			videoTrack_ = ++n;
			uint(t, 0xD7, videoTrack_); uint(t, 0x73C5, videoTrack_); uint(t, 0x83, 1); uint(t, 0x9C, 0);
			str(t, 0x86, v->codec);
			if (v->frameInterval100ns > 0) uint(t, 0x23E383, uint64_t(v->frameInterval100ns) * 100);
			uint(vid, 0xB0, v->width); uint(vid, 0xBA, v->height);
			if (v->codec == "V_UNCOMPRESSED") bin(vid, 0x2EB524, v->fourcc.data(), 4);
			master(t, 0xE0, vid);
			master(tracks, 0xAE, t);
		}
		if (a) {
			Bytes t, aud;
			audioTrack_ = ++n;
			uint(t, 0xD7, audioTrack_); uint(t, 0x73C5, audioTrack_); uint(t, 0x83, 2); uint(t, 0x9C, 0);
			str(t, 0x86, a->isFloat ? "A_PCM/FLOAT/IEEE" : "A_PCM/INT/LIT");
			flt(aud, 0xB5, a->sampleRate); uint(aud, 0x9F, a->channels); uint(aud, 0x6264, a->bits);
			master(t, 0xE1, aud);
			master(tracks, 0xAE, t);
		}
		master(b, 0x1654AE6B, tracks);
		return put(b);
	}

	// ts100ns must be >= 0. Returns false on a write error (pipe closed).
	bool frame(bool video, int64_t ts100ns, const uint8_t *data, size_t size) {
		const int track = video ? videoTrack_ : audioTrack_;
		if (!track) return true;
		const int64_t tc = ts100ns / 1000;
		int64_t rel = tc - clusterTc_;
		if (!clusterOpen_ || rel > 30000 || (video && rel > 10000)) {
			Bytes c;
			id(c, 0x1F43B675); unknownSize(c);
			uint(c, 0xE7, uint64_t(tc));
			if (!put(c)) return false;
			clusterTc_ = tc; clusterOpen_ = true; rel = 0;
		}
		if (rel < -32768) { ++late_; return true; } // far older than the cluster: drop
		Bytes h;
		id(h, 0xA3);
		size8(h, size + 4);
		h.push_back(uint8_t(0x80 | track));
		h.push_back(uint8_t(uint16_t(int16_t(rel)) >> 8));
		h.push_back(uint8_t(uint16_t(int16_t(rel))));
		h.push_back(0x80); // keyframe (raw/MJPEG frames are all independent)
		if (!put(h)) return false;
		return size == 0 || std::fwrite(data, 1, size, out_) == size;
	}

	bool flush() { return std::fflush(out_) == 0; }
	uint64_t lateDropped() const { return late_; }

private:
	bool put(const Bytes &b) { return std::fwrite(b.data(), 1, b.size(), out_) == b.size(); }
	FILE *out_;
	int videoTrack_ = 0, audioTrack_ = 0;
	int64_t clusterTc_ = 0;
	bool clusterOpen_ = false;
	uint64_t late_ = 0;
};

} // namespace mkv
