package sh.ovis.push;

import java.math.BigInteger;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;

/**
 * This phone's push keys, as a browser makes them for a subscription (RFC 8291 section 2): a
 * P-256 key pair whose public half and an authentication secret go to each PC, which encrypts its
 * pushes for them. One set serves every PC: each PC's endpoint takes only that PC's pushes (the
 * relay pins its VAPID key), and only this phone holds the private half.
 */
final class PushKeys {
    final byte[] privateScalar;
    /** the uncompressed point, 65 bytes: what a PC gets as p256dh */
    final byte[] publicPoint;
    /** 16 bytes: what a PC gets as auth */
    final byte[] auth;

    PushKeys(byte[] privateScalar, byte[] publicPoint, byte[] auth) {
        this.privateScalar = privateScalar;
        this.publicPoint = publicPoint;
        this.auth = auth;
    }

    static PushKeys generate() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        ECPoint point = ((ECPublicKey) pair.getPublic()).getW();
        byte[] publicPoint = new byte[65];
        publicPoint[0] = 4;
        System.arraycopy(unsigned32(point.getAffineX()), 0, publicPoint, 1, 32);
        System.arraycopy(unsigned32(point.getAffineY()), 0, publicPoint, 33, 32);
        byte[] auth = new byte[16];
        new SecureRandom().nextBytes(auth);
        return new PushKeys(unsigned32(((ECPrivateKey) pair.getPrivate()).getS()), publicPoint, auth);
    }

    PrivateKey privateKey() throws GeneralSecurityException {
        return KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, privateScalar), p256()));
    }

    /** A P-256 public key from its uncompressed point (a sender's key in a push's header). */
    static PublicKey publicKey(byte[] point) throws GeneralSecurityException {
        if (point.length != 65 || point[0] != 4) throw new GeneralSecurityException("not an uncompressed P-256 point");
        ECPoint w = new ECPoint(new BigInteger(1, Arrays.copyOfRange(point, 1, 33)), new BigInteger(1, Arrays.copyOfRange(point, 33, 65)));
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(w, p256()));
    }

    private static ECParameterSpec p256() throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }

    /** A coordinate or scalar as exactly 32 big-endian bytes. */
    private static byte[] unsigned32(BigInteger value) {
        byte[] bytes = value.toByteArray();
        if (bytes.length == 32) return bytes;
        byte[] fixed = new byte[32];
        if (bytes.length > 32) System.arraycopy(bytes, bytes.length - 32, fixed, 0, 32);
        else System.arraycopy(bytes, 0, fixed, 32 - bytes.length, bytes.length);
        return fixed;
    }
}
