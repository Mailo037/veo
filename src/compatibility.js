import path from 'node:path';
import { rename, rm } from 'node:fs/promises';

export async function ensureCompatibility(file, { backend, runner, signal, convert = false, reporter }) {
  const executable = name => path.join(backend.ffmpegLocation, name + (process.platform === 'win32' ? '.exe' : ''));
  let streams;
  try {
    const raw = await runner(executable('ffprobe'), ['-v', 'error', '-show_streams', '-of', 'json', file], { signal });
    streams = JSON.parse(raw).streams;
    if (!Array.isArray(streams)) throw new Error('No stream metadata');
  } catch (error) {
    if (signal?.aborted || convert) throw error;
    reporter?.status('Playback compatibility could not be checked; original media retained.');
    return file;
  }
  const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.filter(stream => stream.codec_type === 'audio');
  if (!video) return file;
  const videoOK = video.codec_name === 'h264' && video.pix_fmt === 'yuv420p';
  const audioOK = audio.every(stream => stream.codec_name === 'aac');
  if (!convert) {
    if (!videoOK || !audioOK) reporter?.status(`Playback note: ${video.codec_name}/${audio.map(stream => stream.codec_name).join(',') || 'no audio'} may require additional player codecs. Original quality retained; use --compatible for H.264/AAC conversion.`);
    return file;
  }
  if (videoOK && audioOK && path.extname(file) === '.mp4') return file;
  if (!videoOK && (video.color_transfer === 'smpte2084' || video.color_transfer === 'arib-std-b67')) throw new Error('HDR conversion needs tone mapping; original download retained. Use an HDR-capable player or disable --compatible.');
  reporter?.status(videoOK && audioOK ? 'Preparing compatible MP4 without re-encoding…' : 'Converting to compatible H.264/AAC; this takes time and may lose quality…');
  const temporary = path.join(path.dirname(file), 'compatible-output.mp4');
  const target = path.join(path.dirname(file), 'media.mp4');
  try {
    await runner(executable('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file,
      '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0',
      '-c:v', videoOK ? 'copy' : 'libx264', ...(!videoOK ? ['-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p'] : []),
      '-c:a', audioOK ? 'copy' : 'aac', ...(!audioOK ? ['-b:a', '192k'] : []), '-movflags', '+faststart', temporary], { signal });
    await rename(temporary, target);
    if (file !== target) await rm(file);
    return target;
  } finally { await rm(temporary, { force: true }); }
}
