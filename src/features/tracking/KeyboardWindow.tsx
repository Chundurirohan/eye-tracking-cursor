import { useEffect } from "react";
import { OnScreenKeyboard } from "./OnScreenKeyboard";
import { useWindowDwell, DwellHighlight } from "./useWindowDwell";
import { sendKeyboardClose } from "@/core/system/overlayBus";
import { useSettings } from "@/store/settings";
import { playClick } from "@/core/system/sound";
import "@/styles/global.css";

// The on-screen keyboard, as its OWN window docked at the bottom. Keys are
// data-dwell; the local dwell (fed by the main window's broadcast gaze) fires
// them, and each key types into the focused app directly. Closing reports back
// to main to hide the window.

export function KeyboardWindow() {
  const dwell = useWindowDwell();
  const settings = useSettings();

  useEffect(() => {
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <OnScreenKeyboard onClose={() => sendKeyboardClose()}
        onKeyFeedback={() => { if (settings.soundOnClick) playClick(settings.soundVolume); }} />
      <DwellHighlight {...dwell} />
    </div>
  );
}
