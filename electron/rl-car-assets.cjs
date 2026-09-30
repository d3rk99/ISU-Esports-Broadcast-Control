const MAX_MODEL_BYTES = 32 * 1024 * 1024;

function validateCarGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 || buffer.length > MAX_MODEL_BYTES) throw Error('GLB must be under 32 MB.');
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) throw Error('Expected a valid glTF 2.0 binary (.glb).');
  const size = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a || size > buffer.length - 20) throw Error('GLB JSON chunk is invalid.');
  const data = JSON.parse(buffer.toString('utf8', 20, 20 + size).trim());
  if (data.asset?.version !== '2.0') throw Error('Only glTF 2.0 models are supported.');
  // Embedded assets only: no external URLs, local file reads or network requests.
  for (const item of [...(data.buffers || []), ...(data.images || [])]) {
    if (item.uri && !/^data:(application\/octet-stream|application\/gltf-buffer|image\/png|image\/jpeg|image\/webp);base64,[A-Za-z0-9+/=]+$/.test(item.uri)) throw Error('Model must embed all textures and buffers; external resources are not allowed.');
  }
  if ((data.nodes?.length || 0) > 5000 || (data.accessors || []).reduce((sum, item) => sum + (Number(item.count) || 0), 0) > 5000000) throw Error('Model is too complex for the broadcast renderer.');
  if ((data.extensionsRequired || []).some((name) => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(name))) throw Error('Export an uncompressed GLB with PNG/JPEG textures.');
  if (!data.meshes?.length) throw Error('Model contains no meshes.');
  return data;
}

module.exports = { MAX_MODEL_BYTES, validateCarGlb };
