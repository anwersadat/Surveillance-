import QRCode from "qrcode";
import { qrPayloadForCode } from "./codes.js";
export async function generateQRDataUrl(code) {
    const payload = qrPayloadForCode(code);
    return QRCode.toDataURL(payload, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
        color: { dark: "#0b1220", light: "#ffffff" },
    });
}
