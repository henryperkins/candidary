# Exact Linux AMD64 manifest from the lock; no package-manager or moving-tag layer.
FROM python@sha256:61d9f7d6c554f2325f2dd26d627d3efffbd41f56c12ab4deb4ca92f7a157601f AS identity
WORKDIR /build
COPY services/image-decoder/native/ services/image-decoder/native/
COPY shared/image-decoder-contract.ts shared/image-formats.ts shared/mobile-image-cases.json shared/
RUN python services/image-decoder/native/build.py --identity-only

FROM python@sha256:61d9f7d6c554f2325f2dd26d627d3efffbd41f56c12ab4deb4ca92f7a157601f AS build
WORKDIR /build
# Reuse checked dependency layers when only boundary or verification code changes.
COPY --from=identity /build/services/image-decoder/native/build.py /build/services/image-decoder/native/dependencies.lock.json services/image-decoder/native/
RUN python services/image-decoder/native/build.py --dependencies-only
COPY --from=identity /build/services/image-decoder/native/CMakeLists.txt /build/services/image-decoder/native/decode_raw.cpp /build/services/image-decoder/native/patch_dng.py services/image-decoder/native/
RUN python services/image-decoder/native/build.py --raw-helper-only

FROM python@sha256:61d9f7d6c554f2325f2dd26d627d3efffbd41f56c12ab4deb4ca92f7a157601f
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin decoder
COPY --from=build /opt/decoder/ /opt/decoder/
COPY --from=identity /build/services/image-decoder/native/server.py /srv/server.py
COPY --from=identity /build/services/image-decoder/native/inspect_heif.py /srv/inspect_heif.py
COPY --from=identity /build/services/image-decoder/native/inspect_png.py /srv/inspect_png.py
COPY --from=identity /build/services/image-decoder/native/build-identity.json /srv/build-identity.json
COPY --from=identity /build/services/image-decoder/native/policy.xml /opt/decoder/etc/ImageMagick-7/policy.xml
ENV PATH="/opt/decoder/bin:${PATH}" LD_LIBRARY_PATH="/opt/decoder/lib" MAGICK_CONFIGURE_PATH="/opt/decoder/etc/ImageMagick-7" MAGICK_TEMPORARY_PATH="/tmp/candidary-decoder" PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
WORKDIR /srv
EXPOSE 8080
CMD ["python", "/srv/server.py"]
