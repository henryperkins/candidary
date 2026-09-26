// This product includes DNG technology under license by Adobe.
// Fixed-path private helper; invocation and resource limits belong to server.py.
#include <libraw/libraw.h>
#include "dng_host.h"
#include "dng_negative.h"
#include <cstdio>
#include <cstring>
#include <new>

class TrackingHost final : public dng_host {
public:
  unsigned calls = 0;
  dng_negative* Make_dng_negative() override {
    ++calls;
    return dng_host::Make_dng_negative();
  }
};

static int refuse(const char* code) {
  std::printf("{\"error\":\"%s\"}\n", code);
  return 0;
}

int main(int argc, char** argv) {
  if (argc != 2 || std::strcmp(argv[1], "render") != 0) return refuse("unsupported");
  try {
    TrackingHost host; // Must outlive LibRaw and its SDK-owned image/negative.
    LibRaw raw;
    raw.set_dng_host(&host);
    raw.imgdata.rawparams.use_dngsdk = LIBRAW_DNG_ALL | LIBRAW_DNG_DEFLATE;
    raw.imgdata.rawparams.max_raw_memory_mb = 1536;
    raw.imgdata.params.use_camera_wb = 1;
    raw.imgdata.params.no_auto_bright = 1;
    raw.imgdata.params.user_qual = 3;
    raw.imgdata.params.output_color = 1;
    raw.imgdata.params.output_bps = 8;
    raw.imgdata.params.gamm[0] = 1.0 / 2.4;
    raw.imgdata.params.gamm[1] = 12.92;
    if (raw.open_file("input.bin") != LIBRAW_SUCCESS) return refuse("malformed");
    if (!raw.imgdata.idata.dng_version) return refuse("malformed");
    const auto& size = raw.imgdata.sizes;
    if (!size.raw_width || !size.raw_height ||
        static_cast<unsigned long long>(size.raw_width) * size.raw_height > 300000000)
      return refuse("resource_limit");
    host.calls = 0;
    int status = raw.unpack();
    if (status == LIBRAW_UNSUFFICIENT_MEMORY || status == LIBRAW_TOO_BIG) return refuse("resource_limit");
    if (status != LIBRAW_SUCCESS) return refuse("malformed");
    if (!host.calls || !(raw.imgdata.process_warnings & LIBRAW_WARN_DNGSDK_PROCESSED) ||
        (raw.imgdata.process_warnings & LIBRAW_WARN_DNG_NOT_PROCESSED))
      return refuse("unsupported"); // A fallback decoder never certifies SDK activation.
    status = raw.dcraw_process();
    if (status != LIBRAW_SUCCESS) return refuse("malformed");
    libraw_processed_image_t* image = raw.dcraw_make_mem_image(&status);
    if (!image || status != LIBRAW_SUCCESS) return refuse("resource_limit");
    const bool valid = image->type == LIBRAW_IMAGE_BITMAP && image->colors == 3 && image->bits == 8 &&
      image->width && image->height && image->data_size == static_cast<unsigned long long>(image->width) * image->height * 3;
    if (!valid) { LibRaw::dcraw_clear_mem(image); return refuse("unsupported"); }
    FILE* output = std::fopen("raw.ppm", "wb");
    if (!output) { LibRaw::dcraw_clear_mem(image); return refuse("unavailable"); }
    const bool header = std::fprintf(output, "P6\n%u %u\n255\n", image->width, image->height) > 0;
    const bool pixels = std::fwrite(image->data, 1, image->data_size, output) == image->data_size;
    const bool closed = std::fclose(output) == 0;
    if (!header || !pixels || !closed) { LibRaw::dcraw_clear_mem(image); return refuse("resource_limit"); }
    std::printf("{\"family\":\"dng\",\"width\":%u,\"height\":%u,\"frameCount\":1,\"primaryIndex\":0,\"isSequence\":false,\"sdkUsed\":true}\n", image->width, image->height);
    LibRaw::dcraw_clear_mem(image);
    return 0;
  } catch (const std::bad_alloc&) { return refuse("resource_limit"); }
    catch (...) { return refuse("malformed"); }
}
