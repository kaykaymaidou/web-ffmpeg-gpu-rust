// Pure Rust MP4 Muxer with FastStart streaming order

/// Video codec format in MP4 container.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    H265,
}

#[derive(Debug, Clone)]
pub struct VideoTrackConfig {
    pub codec: VideoCodec,
    pub width: u32,
    pub height: u32,
    pub timescale: u32,
    pub vps: Option<Vec<u8>>,
    pub sps: Vec<u8>,
    pub pps: Vec<u8>,
}

impl VideoTrackConfig {
    pub fn new_h264(width: u32, height: u32, timescale: u32, sps: Vec<u8>, pps: Vec<u8>) -> Self {
        Self {
            codec: VideoCodec::H264,
            width,
            height,
            timescale,
            vps: None,
            sps,
            pps,
        }
    }

    pub fn new_h265(
        width: u32,
        height: u32,
        timescale: u32,
        vps: Vec<u8>,
        sps: Vec<u8>,
        pps: Vec<u8>,
    ) -> Self {
        Self {
            codec: VideoCodec::H265,
            width,
            height,
            timescale,
            vps: Some(vps),
            sps,
            pps,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AudioTrackConfig {
    pub timescale: u32,
    pub sample_rate: u32,
    pub channels: u16,
    pub config: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
struct SampleInfo {
    is_video: bool,
    is_key: bool,
    duration_ticks: u32,
    size: usize,
    relative_offset: usize, // relative to mdat start payload
}

pub struct RustMp4Muxer {
    video_config: Option<VideoTrackConfig>,
    audio_config: Option<AudioTrackConfig>,
    samples: Vec<SampleInfo>,
    video_sample_count: usize,
    audio_sample_count: usize,
    mdat_payload: Vec<u8>,
}

impl RustMp4Muxer {
    pub fn new() -> Self {
        Self {
            video_config: None,
            audio_config: None,
            samples: Vec::new(),
            video_sample_count: 0,
            audio_sample_count: 0,
            mdat_payload: Vec::new(),
        }
    }

    pub fn set_video_track(&mut self, config: VideoTrackConfig) {
        self.video_config = Some(config);
    }

    pub fn set_audio_track(&mut self, config: AudioTrackConfig) {
        self.audio_config = Some(config);
    }

    /// Write an H.264 video sample (AVCC NALU payload, with 4-byte length prefix).
    pub fn write_video_sample(&mut self, data: &[u8], duration_ticks: u32, is_key: bool) {
        let relative_offset = self.mdat_payload.len();
        self.mdat_payload.extend_from_slice(data);
        self.samples.push(SampleInfo {
            is_video: true,
            is_key,
            duration_ticks,
            size: data.len(),
            relative_offset,
        });
        self.video_sample_count += 1;
    }

    /// Write an AAC raw audio sample.
    pub fn write_audio_sample(&mut self, data: &[u8], duration_ticks: u32) {
        let relative_offset = self.mdat_payload.len();
        self.mdat_payload.extend_from_slice(data);
        self.samples.push(SampleInfo {
            is_video: false,
            is_key: true,
            duration_ticks,
            size: data.len(),
            relative_offset,
        });
        self.audio_sample_count += 1;
    }

    /// Finalize and assemble the complete MP4 byte buffer with `faststart` (moov before mdat).
    pub fn finalize(&self) -> Vec<u8> {
        let is_hevc = self.video_config.as_ref().map(|v| v.codec == VideoCodec::H265).unwrap_or(false);
        let ftyp = build_ftyp(is_hevc);
        let ftyp_len = ftyp.len();

        // 1. Build moov with dummy zero offsets to measure exact moov byte length
        let dummy_moov = self.build_moov(0);
        let moov_len = dummy_moov.len();

        // 2. Compute exact absolute base offset for mdat payload
        // file_layout: [ftyp] (ftyp_len) + [moov] (moov_len) + [mdat header] (8 bytes) + [mdat payload]
        let base_offset = (ftyp_len + moov_len + 8) as u32;

        // 3. Rebuild moov with precise absolute offsets
        let real_moov = self.build_moov(base_offset);
        assert_eq!(real_moov.len(), moov_len, "moov length must be invariant to offset values");

        // 4. Build mdat box
        let mdat_header = write_box_header(b"mdat", (self.mdat_payload.len() + 8) as u32);

        // 5. Assemble final buffer: ftyp + moov + mdat (FastStart streaming order)
        let total_size = ftyp_len + moov_len + 8 + self.mdat_payload.len();
        let mut out = Vec::with_capacity(total_size);
        out.extend_from_slice(&ftyp);
        out.extend_from_slice(&real_moov);
        out.extend_from_slice(&mdat_header);
        out.extend_from_slice(&self.mdat_payload);

        out
    }

    fn build_moov(&self, base_offset: u32) -> Vec<u8> {
        let movie_timescale = 1000u32;
        let mut moov_children = Vec::new();

        // Calculate total durations
        let video_duration_movie_ts = if let Some(ref v) = self.video_config {
            let total_ticks: u64 = self.samples.iter()
                .filter(|s| s.is_video)
                .map(|s| s.duration_ticks as u64)
                .sum();
            if v.timescale > 0 {
                (total_ticks * movie_timescale as u64 / v.timescale as u64) as u32
            } else {
                0
            }
        } else {
            0
        };

        let audio_duration_movie_ts = if let Some(ref a) = self.audio_config {
            let total_ticks: u64 = self.samples.iter()
                .filter(|s| !s.is_video)
                .map(|s| s.duration_ticks as u64)
                .sum();
            if a.timescale > 0 {
                (total_ticks * movie_timescale as u64 / a.timescale as u64) as u32
            } else {
                0
            }
        } else {
            0
        };

        let max_duration = video_duration_movie_ts.max(audio_duration_movie_ts);
        let mut track_count = 0;
        if self.video_config.is_some() { track_count += 1; }
        if self.audio_config.is_some() { track_count += 1; }
        let next_track_id = track_count + 1;

        // 1. mvhd
        moov_children.extend_from_slice(&build_mvhd(movie_timescale, max_duration, next_track_id));

        // 2. Video trak
        let mut current_track_id = 1;
        if let Some(ref v) = self.video_config {
            let video_samples: Vec<&SampleInfo> = self.samples.iter().filter(|s| s.is_video).collect();
            let total_track_ticks: u32 = video_samples.iter().map(|s| s.duration_ticks).sum();
            let trak = self.build_video_trak(current_track_id, v, &video_samples, total_track_ticks, video_duration_movie_ts, base_offset);
            moov_children.extend_from_slice(&trak);
            current_track_id += 1;
        }

        // 3. Audio trak
        if let Some(ref a) = self.audio_config {
            let audio_samples: Vec<&SampleInfo> = self.samples.iter().filter(|s| !s.is_video).collect();
            let total_track_ticks: u32 = audio_samples.iter().map(|s| s.duration_ticks).sum();
            let trak = self.build_audio_trak(current_track_id, a, &audio_samples, total_track_ticks, audio_duration_movie_ts, base_offset);
            moov_children.extend_from_slice(&trak);
        }

        write_box(b"moov", &moov_children)
    }

    fn build_video_trak(&self, track_id: u32, config: &VideoTrackConfig, samples: &[&SampleInfo], track_ticks: u32, duration_movie_ts: u32, base_offset: u32) -> Vec<u8> {
        let mut trak_children = Vec::new();

        // tkhd
        trak_children.extend_from_slice(&build_tkhd(track_id, duration_movie_ts, config.width, config.height, false));

        // mdia
        let mut mdia_children = Vec::new();
        mdia_children.extend_from_slice(&build_mdhd(config.timescale, track_ticks));
        mdia_children.extend_from_slice(&build_hdlr(b"vide", "VideoHandler"));

        // minf
        let mut minf_children = Vec::new();
        minf_children.extend_from_slice(&build_vmhd());
        minf_children.extend_from_slice(&build_dinf());

        // stbl
        let mut stbl_children = Vec::new();
        stbl_children.extend_from_slice(&build_stsd_video(config));
        stbl_children.extend_from_slice(&build_stts(samples));
        stbl_children.extend_from_slice(&build_stss(samples));
        let runs = chunk_runs(samples);
        stbl_children.extend_from_slice(&build_stsc(&runs));
        stbl_children.extend_from_slice(&build_stsz(samples));
        stbl_children.extend_from_slice(&build_stco(&runs, base_offset));

        minf_children.extend_from_slice(&write_box(b"stbl", &stbl_children));
        mdia_children.extend_from_slice(&write_box(b"minf", &minf_children));
        trak_children.extend_from_slice(&write_box(b"mdia", &mdia_children));

        write_box(b"trak", &trak_children)
    }

    fn build_audio_trak(&self, track_id: u32, config: &AudioTrackConfig, samples: &[&SampleInfo], track_ticks: u32, duration_movie_ts: u32, base_offset: u32) -> Vec<u8> {
        let mut trak_children = Vec::new();

        // tkhd (audio volume = 0x0100, width = 0, height = 0)
        trak_children.extend_from_slice(&build_tkhd(track_id, duration_movie_ts, 0, 0, true));

        // mdia
        let mut mdia_children = Vec::new();
        mdia_children.extend_from_slice(&build_mdhd(config.timescale, track_ticks));
        mdia_children.extend_from_slice(&build_hdlr(b"soun", "SoundHandler"));

        // minf
        let mut minf_children = Vec::new();
        minf_children.extend_from_slice(&build_smhd());
        minf_children.extend_from_slice(&build_dinf());

        // stbl
        let mut stbl_children = Vec::new();
        stbl_children.extend_from_slice(&build_stsd_audio(config));
        stbl_children.extend_from_slice(&build_stts(samples));
        // Audio tracks typically do not have stss (all frames are sync frames)
        let runs = chunk_runs(samples);
        stbl_children.extend_from_slice(&build_stsc(&runs));
        stbl_children.extend_from_slice(&build_stsz(samples));
        stbl_children.extend_from_slice(&build_stco(&runs, base_offset));

        minf_children.extend_from_slice(&write_box(b"stbl", &stbl_children));
        mdia_children.extend_from_slice(&write_box(b"minf", &minf_children));
        trak_children.extend_from_slice(&write_box(b"mdia", &mdia_children));

        write_box(b"trak", &trak_children)
    }
}

// ----------------------------------------------------------------------------
// Box Writing Helpers
// ----------------------------------------------------------------------------

fn write_box_header(tag: &[u8; 4], size: u32) -> [u8; 8] {
    let mut h = [0u8; 8];
    h[0..4].copy_from_slice(&size.to_be_bytes());
    h[4..8].copy_from_slice(tag);
    h
}

fn write_box(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = (payload.len() + 8) as u32;
    let mut buf = Vec::with_capacity(size as usize);
    buf.extend_from_slice(&size.to_be_bytes());
    buf.extend_from_slice(tag);
    buf.extend_from_slice(payload);
    buf
}

fn build_ftyp(is_hevc: bool) -> Vec<u8> {
    let mut payload = Vec::new();
    if is_hevc {
        payload.extend_from_slice(b"isom"); // major_brand
        payload.extend_from_slice(&0x00000200u32.to_be_bytes()); // minor_version
        payload.extend_from_slice(b"isom");
        payload.extend_from_slice(b"iso2");
        payload.extend_from_slice(b"mp41");
        payload.extend_from_slice(b"hevc");
        payload.extend_from_slice(b"hvc1");
    } else {
        payload.extend_from_slice(b"isom"); // major_brand
        payload.extend_from_slice(&0x00000200u32.to_be_bytes()); // minor_version
        payload.extend_from_slice(b"isom");
        payload.extend_from_slice(b"iso2");
        payload.extend_from_slice(b"avc1");
        payload.extend_from_slice(b"mp41");
    }
    write_box(b"ftyp", &payload)
}

fn build_mvhd(timescale: u32, duration: u32, next_track_id: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version(0) + flags(0)
    payload.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    payload.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&duration.to_be_bytes());
    payload.extend_from_slice(&0x00010000u32.to_be_bytes()); // rate = 1.0
    payload.extend_from_slice(&0x0100u16.to_be_bytes()); // volume = 1.0
    payload.extend_from_slice(&[0u8; 10]); // reserved

    // 3x3 identity matrix
    let matrix: [u32; 9] = [
        0x00010000, 0, 0,
        0, 0x00010000, 0,
        0, 0, 0x40000000,
    ];
    for val in matrix {
        payload.extend_from_slice(&val.to_be_bytes());
    }

    payload.extend_from_slice(&[0u8; 24]); // pre_defined
    payload.extend_from_slice(&next_track_id.to_be_bytes());

    write_box(b"mvhd", &payload)
}

fn build_tkhd(track_id: u32, duration_movie_ts: u32, width: u32, height: u32, is_audio: bool) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.push(0); // version
    payload.extend_from_slice(&[0x00, 0x00, 0x07]); // flags: enabled | in_movie | in_preview
    payload.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    payload.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    payload.extend_from_slice(&track_id.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes()); // reserved
    payload.extend_from_slice(&duration_movie_ts.to_be_bytes());
    payload.extend_from_slice(&[0u8; 8]); // reserved
    payload.extend_from_slice(&0u16.to_be_bytes()); // layer
    payload.extend_from_slice(&0u16.to_be_bytes()); // alternate_group
    let volume = if is_audio { 0x0100u16 } else { 0u16 };
    payload.extend_from_slice(&volume.to_be_bytes());
    payload.extend_from_slice(&0u16.to_be_bytes()); // reserved

    // 3x3 identity matrix
    let matrix: [u32; 9] = [
        0x00010000, 0, 0,
        0, 0x00010000, 0,
        0, 0, 0x40000000,
    ];
    for val in matrix {
        payload.extend_from_slice(&val.to_be_bytes());
    }

    // Fixed point 16.16 width and height
    payload.extend_from_slice(&(width << 16).to_be_bytes());
    payload.extend_from_slice(&(height << 16).to_be_bytes());

    write_box(b"tkhd", &payload)
}

fn build_mdhd(timescale: u32, duration_ticks: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags
    payload.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    payload.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&duration_ticks.to_be_bytes());
    payload.extend_from_slice(&0x55c4u16.to_be_bytes()); // language = 'und'
    payload.extend_from_slice(&0u16.to_be_bytes()); // pre_defined

    write_box(b"mdhd", &payload)
}

fn build_hdlr(handler_type: &[u8; 4], name: &str) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags
    payload.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    payload.extend_from_slice(handler_type);
    payload.extend_from_slice(&[0u8; 12]); // reserved
    payload.extend_from_slice(name.as_bytes());
    payload.push(0); // null terminator

    write_box(b"hdlr", &payload)
}

fn build_vmhd() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 1]); // version(0) + flags(1)
    payload.extend_from_slice(&0u16.to_be_bytes()); // graphicsmode = 0
    payload.extend_from_slice(&[0u8; 6]); // opcolor = [0, 0, 0]
    write_box(b"vmhd", &payload)
}

fn build_smhd() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version(0) + flags(0)
    payload.extend_from_slice(&0u16.to_be_bytes()); // balance = 0
    payload.extend_from_slice(&0u16.to_be_bytes()); // reserved = 0
    write_box(b"smhd", &payload)
}

fn build_dinf() -> Vec<u8> {
    let mut dref_payload = Vec::new();
    dref_payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags
    dref_payload.extend_from_slice(&1u32.to_be_bytes()); // entry_count = 1

    // url self-contained box
    let url_box = write_box(b"url ", &[0, 0, 0, 1]); // flags = 1 (data in same file)
    dref_payload.extend_from_slice(&url_box);

    let dref_box = write_box(b"dref", &dref_payload);
    write_box(b"dinf", &dref_box)
}

fn build_stsd_video(config: &VideoTrackConfig) -> Vec<u8> {
    match config.codec {
        VideoCodec::H264 => {
            let mut avc1_payload = Vec::new();
            avc1_payload.extend_from_slice(&[0u8; 6]); // reserved
            avc1_payload.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index = 1
            avc1_payload.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
            avc1_payload.extend_from_slice(&0u16.to_be_bytes()); // reserved
            avc1_payload.extend_from_slice(&[0u8; 12]); // pre_defined [0; 3]
            avc1_payload.extend_from_slice(&(config.width as u16).to_be_bytes());
            avc1_payload.extend_from_slice(&(config.height as u16).to_be_bytes());
            avc1_payload.extend_from_slice(&0x00480000u32.to_be_bytes()); // horizresolution 72 dpi
            avc1_payload.extend_from_slice(&0x00480000u32.to_be_bytes()); // vertresolution 72 dpi
            avc1_payload.extend_from_slice(&0u32.to_be_bytes()); // reserved
            avc1_payload.extend_from_slice(&1u16.to_be_bytes()); // frame_count = 1
            avc1_payload.extend_from_slice(&[0u8; 32]); // compressorname (32 zero bytes)
            avc1_payload.extend_from_slice(&0x0018u16.to_be_bytes()); // depth = 24
            avc1_payload.extend_from_slice(&0xFFFFu16.to_be_bytes()); // pre_defined = -1

            // avcC box
            let avcc_box = build_avcc(&config.sps, &config.pps);
            avc1_payload.extend_from_slice(&avcc_box);

            let avc1_box = write_box(b"avc1", &avc1_payload);

            let mut stsd_payload = Vec::new();
            stsd_payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags
            stsd_payload.extend_from_slice(&1u32.to_be_bytes()); // entry_count = 1
            stsd_payload.extend_from_slice(&avc1_box);

            write_box(b"stsd", &stsd_payload)
        }
        VideoCodec::H265 => {
            let mut hvc1_payload = Vec::new();
            hvc1_payload.extend_from_slice(&[0u8; 6]); // reserved
            hvc1_payload.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index = 1
            hvc1_payload.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
            hvc1_payload.extend_from_slice(&0u16.to_be_bytes()); // reserved
            hvc1_payload.extend_from_slice(&[0u8; 12]); // pre_defined [0; 3]
            hvc1_payload.extend_from_slice(&(config.width as u16).to_be_bytes());
            hvc1_payload.extend_from_slice(&(config.height as u16).to_be_bytes());
            hvc1_payload.extend_from_slice(&0x00480000u32.to_be_bytes()); // horizresolution 72 dpi
            hvc1_payload.extend_from_slice(&0x00480000u32.to_be_bytes()); // vertresolution 72 dpi
            hvc1_payload.extend_from_slice(&0u32.to_be_bytes()); // reserved
            hvc1_payload.extend_from_slice(&1u16.to_be_bytes()); // frame_count = 1
            hvc1_payload.extend_from_slice(&[0u8; 32]); // compressorname (32 zero bytes)
            hvc1_payload.extend_from_slice(&0x0018u16.to_be_bytes()); // depth = 24
            hvc1_payload.extend_from_slice(&0xFFFFu16.to_be_bytes()); // pre_defined = -1

            // hvcC box
            let vps = config.vps.as_deref().unwrap_or(&[]);
            let hvcc_data = crate::bitstream::h265::build_hvcc(vps, &config.sps, &config.pps);
            let hvcc_box = write_box(b"hvcC", &hvcc_data);
            hvc1_payload.extend_from_slice(&hvcc_box);

            let hvc1_box = write_box(b"hvc1", &hvc1_payload);

            let mut stsd_payload = Vec::new();
            stsd_payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags
            stsd_payload.extend_from_slice(&1u32.to_be_bytes()); // entry_count = 1
            stsd_payload.extend_from_slice(&hvc1_box);

            write_box(b"stsd", &stsd_payload)
        }
    }
}

fn build_avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut avcc = Vec::new();
    avcc.push(1); // configurationVersion = 1
    avcc.push(if sps.len() > 1 { sps[1] } else { 0x42 }); // AVCProfileIndication
    avcc.push(if sps.len() > 2 { sps[2] } else { 0x00 }); // profile_compatibility
    avcc.push(if sps.len() > 3 { sps[3] } else { 0x1E }); // AVCLevelIndication
    avcc.push(0xFF); // lengthSizeMinusOne (4-byte NAL length)

    // SPS
    avcc.push(0xE1); // 1 SPS
    avcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(sps);

    // PPS
    avcc.push(1); // 1 PPS
    avcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(pps);

    write_box(b"avcC", &avcc)
}

fn build_stsd_audio(config: &AudioTrackConfig) -> Vec<u8> {
    let mut mp4a_payload = Vec::new();
    mp4a_payload.extend_from_slice(&[0u8; 6]); // reserved
    mp4a_payload.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index = 1
    mp4a_payload.extend_from_slice(&[0u8; 8]); // reserved
    mp4a_payload.extend_from_slice(&config.channels.to_be_bytes());
    mp4a_payload.extend_from_slice(&16u16.to_be_bytes()); // samplesize = 16
    mp4a_payload.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    mp4a_payload.extend_from_slice(&0u16.to_be_bytes()); // reserved
    mp4a_payload.extend_from_slice(&(config.sample_rate << 16).to_be_bytes());

    // ESDS Box
    let asc = if let Some(ref c) = config.config {
        c.clone()
    } else {
        generate_aac_audio_specific_config(config.sample_rate, config.channels)
    };
    let esds_box = build_esds(&asc);
    mp4a_payload.extend_from_slice(&esds_box);

    let mp4a_box = write_box(b"mp4a", &mp4a_payload);

    let mut stsd_payload = Vec::new();
    stsd_payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags
    stsd_payload.extend_from_slice(&1u32.to_be_bytes()); // entry_count = 1
    stsd_payload.extend_from_slice(&mp4a_box);

    write_box(b"stsd", &stsd_payload)
}

fn generate_aac_audio_specific_config(sample_rate: u32, channels: u16) -> Vec<u8> {
    let freq_index = match sample_rate {
        96000 => 0,
        88200 => 1,
        64000 => 2,
        48000 => 3,
        44100 => 4,
        32000 => 5,
        24000 => 6,
        22050 => 7,
        16000 => 8,
        12000 => 9,
        11025 => 10,
        8000 => 11,
        _ => 4,
    };
    let audio_object_type = 2u16; // AAC-LC
    let val = (audio_object_type << 11) | ((freq_index as u16) << 7) | ((channels & 0x0F) << 3);
    val.to_be_bytes().to_vec()
}

fn build_esds(audio_config: &[u8]) -> Vec<u8> {
    let mut esds = Vec::new();
    esds.extend_from_slice(&[0, 0, 0, 0]); // version + flags

    // DecSpecificInfo (Tag 0x05)
    let mut dec_specific = Vec::new();
    dec_specific.push(0x05);
    dec_specific.push(audio_config.len() as u8);
    dec_specific.extend_from_slice(audio_config);

    // DecoderConfigDescriptor (Tag 0x04)
    let mut dec_config = Vec::new();
    dec_config.push(0x04);
    dec_config.push((13 + dec_specific.len()) as u8);
    dec_config.push(0x40); // objectTypeIndication = 0x40 (Audio ISO/IEC 14496-3 / AAC)
    dec_config.push(0x15); // streamType = 0x15 (AudioStream)
    dec_config.extend_from_slice(&[0x00, 0x00, 0x00]); // bufferSizeDB
    dec_config.extend_from_slice(&0x0001f400u32.to_be_bytes()); // maxBitrate (128 kbps)
    dec_config.extend_from_slice(&0x0001f400u32.to_be_bytes()); // avgBitrate
    dec_config.extend_from_slice(&dec_specific);

    // SLConfigDescriptor (Tag 0x06)
    let sl_config = [0x06, 0x01, 0x02];

    // ES_Descriptor (Tag 0x03)
    let mut es_desc = Vec::new();
    es_desc.push(0x03);
    es_desc.push((3 + dec_config.len() + sl_config.len()) as u8);
    es_desc.extend_from_slice(&1u16.to_be_bytes()); // ES_ID = 1
    es_desc.push(0x00); // flags = 0
    es_desc.extend_from_slice(&dec_config);
    es_desc.extend_from_slice(&sl_config);

    esds.extend_from_slice(&es_desc);
    write_box(b"esds", &esds)
}

fn build_stts(samples: &[&SampleInfo]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags

    if samples.is_empty() {
        payload.extend_from_slice(&0u32.to_be_bytes());
        return write_box(b"stts", &payload);
    }

    // Run-length encode consecutive identical durations
    let mut entries: Vec<(u32, u32)> = Vec::new();
    let mut current_count = 1u32;
    let mut current_dur = samples[0].duration_ticks;

    for s in samples.iter().skip(1) {
        if s.duration_ticks == current_dur {
            current_count += 1;
        } else {
            entries.push((current_count, current_dur));
            current_count = 1;
            current_dur = s.duration_ticks;
        }
    }
    entries.push((current_count, current_dur));

    payload.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (count, dur) in entries {
        payload.extend_from_slice(&count.to_be_bytes());
        payload.extend_from_slice(&dur.to_be_bytes());
    }

    write_box(b"stts", &payload)
}

fn build_stss(samples: &[&SampleInfo]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags

    let keyframes: Vec<u32> = samples.iter().enumerate()
        .filter(|(_, s)| s.is_key)
        .map(|(idx, _)| (idx + 1) as u32) // 1-indexed
        .collect();

    payload.extend_from_slice(&(keyframes.len() as u32).to_be_bytes());
    for k in keyframes {
        payload.extend_from_slice(&k.to_be_bytes());
    }

    write_box(b"stss", &payload)
}

struct ChunkRun {
    sample_count: u32,
    relative_offset: usize,
}

fn chunk_runs(samples: &[&SampleInfo]) -> Vec<ChunkRun> {
    let mut runs = Vec::new();
    if samples.is_empty() {
        return runs;
    }

    let mut sample_count = 1u32;
    let mut relative_offset = samples[0].relative_offset;
    for i in 1..samples.len() {
        let prev = samples[i - 1];
        if samples[i].relative_offset == prev.relative_offset + prev.size {
            sample_count += 1;
        } else {
            runs.push(ChunkRun {
                sample_count,
                relative_offset,
            });
            sample_count = 1;
            relative_offset = samples[i].relative_offset;
        }
    }
    runs.push(ChunkRun {
        sample_count,
        relative_offset,
    });
    runs
}

fn build_stsc(runs: &[ChunkRun]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags

    if runs.is_empty() {
        payload.extend_from_slice(&0u32.to_be_bytes());
        return write_box(b"stsc", &payload);
    }

    let mut entries: Vec<(u32, u32)> = Vec::new();
    for (i, run) in runs.iter().enumerate() {
        if entries.last().map(|e| e.1) != Some(run.sample_count) {
            entries.push((i as u32 + 1, run.sample_count));
        }
    }

    payload.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (first_chunk, samples_per_chunk) in entries {
        payload.extend_from_slice(&first_chunk.to_be_bytes());
        payload.extend_from_slice(&samples_per_chunk.to_be_bytes());
        payload.extend_from_slice(&1u32.to_be_bytes()); // sample_description_index
    }

    write_box(b"stsc", &payload)
}

fn build_stsz(samples: &[&SampleInfo]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags
    payload.extend_from_slice(&0u32.to_be_bytes()); // sample_size = 0 (variable sizes)
    payload.extend_from_slice(&(samples.len() as u32).to_be_bytes()); // sample_count

    for s in samples {
        payload.extend_from_slice(&(s.size as u32).to_be_bytes());
    }

    write_box(b"stsz", &payload)
}

fn build_stco(runs: &[ChunkRun], base_offset: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0, 0, 0, 0]); // version + flags
    payload.extend_from_slice(&(runs.len() as u32).to_be_bytes());

    for run in runs {
        let abs_offset = base_offset + run.relative_offset as u32;
        payload.extend_from_slice(&abs_offset.to_be_bytes());
    }

    write_box(b"stco", &payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::demuxer::Mp4Demuxer;

    #[test]
    fn test_mp4_faststart_roundtrip() {
        let mut muxer = RustMp4Muxer::new();
        
        let sps = vec![0x67, 0x42, 0xC0, 0x1E, 0xD9, 0x00, 0xA0, 0x7B, 0x40];
        let pps = vec![0x68, 0xCE, 0x38, 0x80];

        muxer.set_video_track(VideoTrackConfig::new_h264(
            1280,
            720,
            30000,
            sps,
            pps,
        ));

        muxer.set_audio_track(AudioTrackConfig {
            timescale: 44100,
            sample_rate: 44100,
            channels: 2,
            config: None,
        });

        // Write 3 video samples
        let sample1 = vec![0, 0, 0, 5, 0x65, 1, 2, 3, 4]; // IDR
        let sample2 = vec![0, 0, 0, 5, 0x41, 5, 6, 7, 8]; // Non-IDR
        let sample3 = vec![0, 0, 0, 5, 0x41, 9, 10, 11, 12];

        muxer.write_video_sample(&sample1, 1000, true);
        muxer.write_video_sample(&sample2, 1000, false);
        muxer.write_video_sample(&sample3, 1000, false);

        // Write 2 audio samples
        let audio1 = vec![0xFF, 0xF1, 0x50, 0x80, 0x01, 0x02];
        let audio2 = vec![0xFF, 0xF1, 0x50, 0x80, 0x03, 0x04];
        muxer.write_audio_sample(&audio1, 1024);
        muxer.write_audio_sample(&audio2, 1024);

        let mp4_bytes = muxer.finalize();
        assert!(!mp4_bytes.is_empty());

        // Verify FastStart structure: moov must precede mdat
        let moov_pos = mp4_bytes.windows(4).position(|w| w == b"moov").expect("must have moov");
        let mdat_pos = mp4_bytes.windows(4).position(|w| w == b"mdat").expect("must have mdat");
        assert!(moov_pos < mdat_pos, "moov (pos {}) MUST appear before mdat (pos {}) for FastStart!", moov_pos, mdat_pos);

        // Verify with our own Mp4Demuxer
        let demuxer = Mp4Demuxer::new(&mp4_bytes);
        let tracks = demuxer.parse();
        assert!(!tracks.is_empty(), "Demuxer must successfully parse muxed MP4");
        
        let vtrack = tracks.iter().find(|t| t.codec.starts_with("avc1")).expect("must parse video track");
        assert_eq!(vtrack.width, 1280);
        assert_eq!(vtrack.height, 720);
        assert_eq!(vtrack.samples.len(), 3);
        assert!(vtrack.samples[0].is_key);
        assert!(!vtrack.samples[1].is_key);
    }

    #[test]
    fn test_mp4_hevc_faststart_roundtrip() {
        let mut muxer = RustMp4Muxer::new();

        // Synthetic HEVC parameter sets: VPS (32), SPS (33), PPS (34)
        let vps = vec![0x40, 0x01, 0x0c, 0x01];
        let sps = vec![0x42, 0x01, 0x01, 0x01];
        let pps = vec![0x44, 0x01, 0xc0];

        muxer.set_video_track(VideoTrackConfig::new_h265(
            3840,
            2160,
            60000,
            vps,
            sps,
            pps,
        ));

        // Write 3 HEVC samples (IDR = 0x26, Non-IRAP = 0x02)
        let sample1 = vec![0, 0, 0, 5, 0x26, 0x01, 1, 2, 3]; // IDR
        let sample2 = vec![0, 0, 0, 5, 0x02, 0x01, 4, 5, 6]; // Trail
        let sample3 = vec![0, 0, 0, 5, 0x02, 0x01, 7, 8, 9];

        muxer.write_video_sample(&sample1, 1000, true);
        muxer.write_video_sample(&sample2, 1000, false);
        muxer.write_video_sample(&sample3, 1000, false);

        let mp4_bytes = muxer.finalize();
        assert!(!mp4_bytes.is_empty());

        // Verify FastStart order
        let moov_pos = mp4_bytes.windows(4).position(|w| w == b"moov").expect("must have moov");
        let mdat_pos = mp4_bytes.windows(4).position(|w| w == b"mdat").expect("must have mdat");
        assert!(moov_pos < mdat_pos, "moov must precede mdat");

        // Verify hvc1 & hvcC exist in the byte buffer
        assert!(mp4_bytes.windows(4).any(|w| w == b"hvc1"));
        assert!(mp4_bytes.windows(4).any(|w| w == b"hvcC"));

        // Verify with Mp4Demuxer
        let demuxer = Mp4Demuxer::new(&mp4_bytes);
        let tracks = demuxer.parse();
        assert_eq!(tracks.len(), 1);
        let vtrack = &tracks[0];
        assert!(vtrack.codec.starts_with("hvc1"));
        assert_eq!(vtrack.width, 3840);
        assert_eq!(vtrack.height, 2160);
        assert_eq!(vtrack.samples.len(), 3);
        assert!(vtrack.samples[0].is_key);
        assert!(!vtrack.samples[1].is_key);
    }

    #[test]
    fn test_contiguous_track_collapses_to_one_chunk() {
        let samples = [
            SampleInfo {
                is_video: true,
                is_key: true,
                duration_ticks: 1000,
                size: 10,
                relative_offset: 0,
            },
            SampleInfo {
                is_video: true,
                is_key: false,
                duration_ticks: 1000,
                size: 6,
                relative_offset: 10,
            },
            SampleInfo {
                is_video: true,
                is_key: false,
                duration_ticks: 1000,
                size: 4,
                relative_offset: 16,
            },
        ];
        let refs: Vec<&SampleInfo> = samples.iter().collect();
        let runs = chunk_runs(&refs);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].sample_count, 3);
        assert_eq!(runs[0].relative_offset, 0);

        let interleaved = [
            SampleInfo {
                is_video: true,
                is_key: true,
                duration_ticks: 1000,
                size: 10,
                relative_offset: 0,
            },
            SampleInfo {
                is_video: true,
                is_key: false,
                duration_ticks: 1000,
                size: 6,
                relative_offset: 20,
            },
        ];
        let interleaved_refs: Vec<&SampleInfo> = interleaved.iter().collect();
        let split = chunk_runs(&interleaved_refs);
        assert_eq!(split.len(), 2);
        assert_eq!(split[0].sample_count, 1);
        assert_eq!(split[1].sample_count, 1);
    }
}
