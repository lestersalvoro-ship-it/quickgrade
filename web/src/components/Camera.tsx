import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera as CameraIcon, X } from 'lucide-react';
import { Alert, Button } from './ui';

/**
 * Live camera capture with a sheet-alignment guide. Uses the rear camera at the
 * highest resolution offered, and ImageCapture.takePhoto() when available (full
 * sensor resolution rather than a video frame).
 */
export function CameraCapture({ onCapture, onClose, busy }: { onCapture: (blob: Blob) => void; onClose: () => void; busy?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(window.isSecureContext ? 'This browser cannot access the camera. Use “Upload photo” instead.' : 'The camera needs a secure (HTTPS) connection. Use “Upload photo” — on phones it can open the camera app too.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        setReady(true);
      } catch (e) {
        const name = (e as Error).name;
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access in your browser settings, or use “Upload photo”.'
            : name === 'NotFoundError'
              ? 'No camera was found on this device. Use “Upload photo”.'
              : 'The camera could not be started. Use “Upload photo” instead.',
        );
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const capture = useCallback(async () => {
    const stream = streamRef.current;
    const v = videoRef.current;
    if (!stream || !v) return;
    const track = stream.getVideoTracks()[0];
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
    if (IC) {
      try {
        const blob = await new IC(track).takePhoto();
        if (blob.size > 0) return onCapture(blob);
      } catch {
        /* fall back to a video frame */
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    canvas.toBlob((b) => b && onCapture(b), 'image/jpeg', 0.92);
  }, [onCapture]);

  return (
    <div className="space-y-3">
      {error ? (
        <Alert tone="warn" title="Camera unavailable">
          {error}
        </Alert>
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-black">
          <video ref={videoRef} playsInline muted className="mx-auto max-h-[65vh] w-full object-contain" aria-label="Camera preview" />
          {ready && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
              <div className="relative h-[88%] aspect-[188/258] rounded-md border-2 border-white/70">
                {['left-0 top-0', 'right-0 top-0', 'left-0 bottom-0', 'right-0 bottom-0'].map((p) => (
                  <span key={p} className={`absolute ${p} m-1 size-5 border-4 border-white/90`} />
                ))}
              </div>
            </div>
          )}
          {ready && <p className="absolute inset-x-0 bottom-2 text-center text-xs text-white/90 drop-shadow">Fit the sheet inside the frame · all four black corner squares visible · hold steady</p>}
        </div>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" size="lg" icon={<CameraIcon className="size-5" />} disabled={!ready || busy} loading={busy} onClick={capture}>
          Capture sheet
        </Button>
        <Button size="lg" icon={<X className="size-5" />} onClick={onClose}>
          Close camera
        </Button>
      </div>
    </div>
  );
}
