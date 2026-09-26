/** Complete uncompressed RGB TIFF raster, generated for byte-preservation tests.
 * Not a camera original, native-decoder qualification, or physical-device proof. */
export function mobileImageTestRaster():Uint8Array<ArrayBuffer> {
  const width=3000,height=2400,offset=152,size=width*height*3;
  const bytes=new Uint8Array(offset+size); const view=new DataView(bytes.buffer);
  bytes.set([0x49,0x49,42,0,8,0,0,0]); view.setUint16(8,11,true);
  const tags=[[256,4,1,width],[257,4,1,height],[258,3,3,146],[259,3,1,1],[262,3,1,2],
    [273,4,1,offset],[274,3,1,1],[277,3,1,3],[278,4,1,height],[279,4,1,size],[284,3,1,1]];
  tags.forEach(([tag,type,count,value],i) => { const pos=10+i*12;
    view.setUint16(pos,tag!,true); view.setUint16(pos+2,type!,true); view.setUint32(pos+4,count!,true); view.setUint32(pos+8,value!,true);
  });
  for (let i=0;i<3;i++) view.setUint16(146+i*2,8,true);
  for (let i=0;i<size;i++) bytes[offset+i]=(i*17+(i>>>12))&255;
  return bytes;
}
