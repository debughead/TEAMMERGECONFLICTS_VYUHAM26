// Minimal types for the parts of piexifjs 1.0.6 the sample generator uses (checked against piexif.js).
// The package is CommonJS (module.exports = piexif), so it is consumed as a default import.
declare module "piexifjs" {
  type Rational = [number, number];
  type ExifValue = string | number | Rational | Rational[] | number[];
  interface ExifDict {
    "0th"?: Record<number, ExifValue>;
    Exif?: Record<number, ExifValue>;
    GPS?: Record<number, ExifValue>;
  }
  const piexif: {
    /** Binary-string in, binary-string out. */
    dump(exif: ExifDict): string;
    insert(exif: string, jpegBinaryString: string): string;
    ImageIFD: Record<"Make" | "Model" | "Orientation" | "Software" | "Artist", number>;
    ExifIFD: Record<"DateTimeOriginal", number>;
    GPSIFD: Record<"GPSLatitudeRef" | "GPSLatitude" | "GPSLongitudeRef" | "GPSLongitude", number>;
    GPSHelper: { degToDmsRational(deg: number): Rational[] };
  };
  export default piexif;
}
