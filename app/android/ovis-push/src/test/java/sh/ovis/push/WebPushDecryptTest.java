package sh.ovis.push;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.KeyAgreement;
import org.junit.Test;

public class WebPushDecryptTest {
    private static byte[] b64(String value) {
        return Base64.getUrlDecoder().decode(value);
    }

    /** RFC 8291 section 5 and appendix A: the user agent's keys and the message they open. */
    private static final PushKeys RFC_KEYS = new PushKeys(
        b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
        b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
        b64("BTBZMqHH6r4Tts7J_aSIgg")
    );
    /** the 86-byte header (salt, record size 4096, the sender's key) and the ciphertext, as the RFC gives them */
    private static final String RFC_HEADER =
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    private static final String RFC_CIPHERTEXT = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";

    private static byte[] rfcMessage() {
        byte[] header = b64(RFC_HEADER);
        byte[] ciphertext = b64(RFC_CIPHERTEXT);
        byte[] message = Arrays.copyOf(header, header.length + ciphertext.length);
        System.arraycopy(ciphertext, 0, message, header.length, ciphertext.length);
        return message;
    }

    @Test
    public void opensTheRfcExample() throws GeneralSecurityException {
        byte[] plain = WebPushDecrypt.decrypt(rfcMessage(), RFC_KEYS);
        assertEquals("When I grow up, I want to be a watermelon", new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void refusesAChangedCiphertext() {
        byte[] message = rfcMessage();
        message[message.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> WebPushDecrypt.decrypt(message, RFC_KEYS));
    }

    @Test
    public void refusesOtherKeys() throws GeneralSecurityException {
        PushKeys other = PushKeys.generate();
        assertThrows(GeneralSecurityException.class, () -> WebPushDecrypt.decrypt(rfcMessage(), other));
    }

    /** The stored halves belong together: each side's private key with the other's public point agree. */
    @Test
    public void generatesMatchingHalves() throws GeneralSecurityException {
        PushKeys a = PushKeys.generate();
        PushKeys b = PushKeys.generate();
        assertEquals(65, a.publicPoint.length);
        assertEquals(16, a.auth.length);
        assertArrayEquals(secret(a, b), secret(b, a));
    }

    private static byte[] secret(PushKeys own, PushKeys other) throws GeneralSecurityException {
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(own.privateKey());
        agreement.doPhase(PushKeys.publicKey(other.publicPoint), true);
        return agreement.generateSecret();
    }
}
