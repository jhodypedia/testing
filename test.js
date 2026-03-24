const readline = require("readline");
const gobiz = require("./src/gopay");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q) {
  return new Promise(r => rl.question(q, r));
}

(async () => {
  const USER_ID = "me";

  try {
    console.log("=== GoBiz Test CLI (Auto Refresh + Mutasi + Rupiah) ===");
    console.log("1) Login Email + Password");
    console.log("2) Login Nomor (OTP)");
    const mode = (await ask("Pilih metode login (1/2): ")).trim();

    if (mode === "1") {
      const email = (await ask("Email: ")).trim();
      const password = (await ask("Password: ")).trim();
      await gobiz.emailLogin(USER_ID, email, password);
      console.log("Login email berhasil");
    } else if (mode === "2") {
      let phone = (await ask("Nomor HP (tanpa 0 / +62): ")).trim();
      phone = phone.replace(/\D/g, "").replace(/^0/, "");

      const otpReq = await gobiz.requestOTP(USER_ID, phone, "62");
      console.log("OTP TOKEN:", otpReq.otp_token);
      console.log("OTP LEN  :", otpReq.otp_length);
      console.log("EXPIRE   :", otpReq.otp_expires_in);
      console.log("STATE    :", otpReq.next_state?.state || "");

      const otp = (await ask("Masukkan OTP: ")).trim();
      await gobiz.verifyOTP(USER_ID, otp, otpReq.otp_token);
      console.log("Login OTP berhasil");
    } else {
      console.log("Pilihan tidak valid");
      process.exit(1);
    }

    const merchantId = await gobiz.getMerchantId(USER_ID);
    console.log("Merchant ID:", merchantId);

    console.log("Listener mutasi aktif (Ctrl+C untuk stop)...");
    gobiz.startMutasiListener(
      USER_ID,
      merchantId,
      (tx) => {
        console.log("=== MUTASI BARU ===");
        console.log("ID        :", tx.id);
        console.log("Waktu     :", tx.time);
        console.log("Status    :", tx.status);
        console.log("Metode    :", tx.paymentType);
        console.log("OrderID   :", tx.orderId);
        console.log("Nominal   :", tx.amountFormatted);
        console.log("NominalSen:", tx.amountSen);
        console.log("===================");
      },
      15000
    );

    rl.close();
  } catch (e) {
    console.error("ERROR:", e?.message || e);
    rl.close();
    process.exit(1);
  }
})();
