package sh.ovis.push;

import android.content.Context;
import android.content.SharedPreferences;
import java.security.GeneralSecurityException;
import java.util.Base64;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * This phone's push keys and the relay endpoint each PC was given, in the app's private
 * preferences. An endpoint is kept with the FCM token and PC key it was made for: a new token or
 * key means a new endpoint, which the PC gets at its next subscribe.
 */
final class PushStore {
    private static final String PREFS = "ovis_push";

    /** a PC's relay endpoint, the FCM token behind it and the PC key the relay pinned it to */
    static final class Endpoint {
        final String endpoint;
        final String token;
        final String vapidKey;

        Endpoint(String endpoint, String token, String vapidKey) {
            this.endpoint = endpoint;
            this.token = token;
            this.vapidKey = vapidKey;
        }
    }

    private PushStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The keys, made on first use. */
    static synchronized PushKeys keys(Context context) throws GeneralSecurityException {
        SharedPreferences prefs = prefs(context);
        String scalar = prefs.getString("private", null);
        String point = prefs.getString("public", null);
        String auth = prefs.getString("auth", null);
        if (scalar != null && point != null && auth != null) {
            Base64.Decoder decoder = Base64.getDecoder();
            return new PushKeys(decoder.decode(scalar), decoder.decode(point), decoder.decode(auth));
        }
        PushKeys keys = PushKeys.generate();
        Base64.Encoder encoder = Base64.getEncoder();
        prefs.edit()
            .putString("private", encoder.encodeToString(keys.privateScalar))
            .putString("public", encoder.encodeToString(keys.publicPoint))
            .putString("auth", encoder.encodeToString(keys.auth))
            .commit();
        return keys;
    }

    static synchronized Endpoint endpoint(Context context, String origin) {
        JSONObject entry = endpoints(context).optJSONObject(origin);
        if (entry == null) return null;
        return new Endpoint(entry.optString("endpoint"), entry.optString("token"), entry.optString("vapidKey"));
    }

    static synchronized void saveEndpoint(Context context, String origin, String endpoint, String token, String vapidKey) throws JSONException {
        JSONObject all = endpoints(context);
        all.put(origin, new JSONObject().put("endpoint", endpoint).put("token", token).put("vapidKey", vapidKey));
        prefs(context).edit().putString("endpoints", all.toString()).apply();
    }

    static synchronized void forget(Context context, String origin) {
        JSONObject all = endpoints(context);
        all.remove(origin);
        prefs(context).edit().putString("endpoints", all.toString()).apply();
    }

    private static JSONObject endpoints(Context context) {
        try {
            return new JSONObject(prefs(context).getString("endpoints", "{}"));
        } catch (JSONException damaged) {
            return new JSONObject(); // a damaged list starts empty: each PC subscribes again
        }
    }
}
