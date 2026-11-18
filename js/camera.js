// 拍照：手機用系統相機（<input capture>），電腦用網頁內建的相機視窗（getUserMedia）。

import { icon } from './icons.js';
import { esc, openModal, toast } from './ui.js';

const hasStream = () => !!(navigator.mediaDevices?.getUserMedia) && window.isSecureContext !== false;
const match = (q) => { try { return window.matchMedia(q).matches; } catch { return false; } };

/**
 * 這台裝置要怎麼拍照：
 *  'native' = 觸控裝置，<input capture> 會開系統相機
 *  'modal'  = 電腦（capture 會被忽略），改開網頁裡的相機視窗
 *  null     = 兩種都做不到，隱藏「拍照」
 */
export function cameraMode() {
  if (match('(pointer: coarse)') || match('(hover: none)')) return 'native';
  if (hasStream()) return 'modal';
  return navigator.maxTouchPoints > 0 ? 'native' : null;
}

function describeError(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '沒有取得相機權限。請在瀏覽器網址列允許使用相機，或改為上傳圖片。';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return '找不到可以使用的相機。你可以改為上傳圖片。';
    case 'NotReadableError':
    case 'AbortError':
      return '相機目前無法使用，可能正被其他程式占用。你可以改為上傳圖片。';
    default:
      return '無法開啟相機。你可以改為上傳圖片。';
  }
}

/**
 * 相機視窗。拍好、按「使用這張」時回傳 JPEG Blob；關閉或改選上傳時回傳 null。
 * onFallback：使用者按「改為上傳圖片」時，在那一下點擊裡同步呼叫（才能開啟選檔視窗）。
 */
export function openCameraModal({ onFallback } = {}) {
  return new Promise((resolve) => {
    let stream = null;
    let result = null;
    let shot = null;       // 目前拍下的照片（Blob）
    let shotUrl = '';
    let closed = false;
    let devices = [];
    let deviceIdx = -1;
    let facing = 'environment';

    const m = openModal({
      title: '拍照',
      className: 'modal-camera',
      content: `
        <div class="camera">
          <div class="camera-stage">
            <video playsinline muted autoplay></video>
            <img class="camera-shot" alt="剛拍的照片" hidden>
            <div class="camera-msg" hidden></div>
          </div>
          <div class="camera-bar" data-live>
            <span class="camera-side"><button type="button" class="icon-btn" data-switch aria-label="切換鏡頭" hidden>${icon('refresh', 22)}</button></span>
            <button type="button" class="shutter" data-shutter aria-label="拍下照片" disabled><span></span></button>
            <span class="camera-side"></span>
          </div>
          <div class="camera-bar review" data-review hidden>
            <button type="button" class="btn" data-retake>重拍</button>
            <button type="button" class="btn btn-primary" data-use>${icon('check', 18)}<span>使用這張</span></button>
          </div>
          <div class="camera-bar review" data-error hidden>
            <button type="button" class="btn btn-primary" data-fallback>${icon('upload', 18)}<span>改為上傳圖片</span></button>
          </div>
        </div>`,
      onClose: () => { closed = true; stop(); if (shotUrl) URL.revokeObjectURL(shotUrl); resolve(result); },
    });

    const $ = (s) => m.body.querySelector(s);
    const video = $('video');
    const shotImg = $('.camera-shot');
    const msg = $('.camera-msg');
    const shutter = $('[data-shutter]');
    const switchBtn = $('[data-switch]');
    const bars = { live: $('[data-live]'), review: $('[data-review]'), error: $('[data-error]') };
    const show = (which) => { for (const k in bars) bars[k].hidden = k !== which; };

    function stop() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    }

    function fail(e) {
      console.warn('camera unavailable', e);
      stop();
      video.hidden = true;
      msg.hidden = false;
      msg.innerHTML = `<span class="camera-msg-ico">${icon('camera', 30)}</span><p>${esc(describeError(e))}</p>`;
      shutter.disabled = true;
      show('error');
    }

    async function start() {
      stop();
      shutter.disabled = true;
      try {
        const video_ = { width: { ideal: 1920 }, height: { ideal: 1080 } };
        if (deviceIdx >= 0 && devices[deviceIdx]?.deviceId) video_.deviceId = { exact: devices[deviceIdx].deviceId };
        else video_.facingMode = facing;
        const s = await navigator.mediaDevices.getUserMedia({ video: video_, audio: false });
        if (closed) { s.getTracks().forEach((t) => t.stop()); return; } // 還沒開好就被關掉了
        stream = s;
        const st = s.getVideoTracks()[0]?.getSettings?.() || {};
        // 前鏡頭（或電腦的視訊鏡頭）畫面左右鏡像，像照鏡子；存下來的照片不鏡像
        video.classList.toggle('mirror', st.facingMode === 'user' || (!st.facingMode && deviceIdx < 0 && facing !== 'environment'));
        video.srcObject = s;
        await video.play().catch(() => {});
        shutter.disabled = false;
        // 權限給了之後才列得出鏡頭名稱／數量
        try {
          devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
          const cur = st.deviceId;
          if (deviceIdx < 0) deviceIdx = Math.max(0, devices.findIndex((d) => d.deviceId === cur));
          switchBtn.hidden = devices.length < 2;
        } catch { /* 沒有切換鏡頭而已 */ }
      } catch (e) {
        if (!closed) fail(e);
      }
    }

    switchBtn.addEventListener('click', () => {
      if (devices.length < 2) return;
      deviceIdx = (deviceIdx + 1) % devices.length;
      start();
    });

    shutter.addEventListener('click', () => {
      if (!stream || !video.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      c.toBlob((b) => {
        if (!b || closed) { if (!b) toast('拍照失敗，請再試一次', 'error'); return; }
        shot = b;
        if (shotUrl) URL.revokeObjectURL(shotUrl);
        shotUrl = URL.createObjectURL(b);
        shotImg.src = shotUrl;
        shotImg.hidden = false;
        video.hidden = true;
        video.pause();
        show('review');
      }, 'image/jpeg', 0.92);
    });

    $('[data-retake]').addEventListener('click', () => {
      shot = null;
      shotImg.hidden = true;
      video.hidden = false;
      video.play().catch(() => {});
      show('live');
    });

    $('[data-use]').addEventListener('click', () => { result = shot; m.close(true); });

    $('[data-fallback]').addEventListener('click', () => {
      onFallback?.(); // 要在這次點擊裡同步呼叫，瀏覽器才允許開啟選檔視窗
      m.close(true);
    });

    show('live');
    start();
  });
}
