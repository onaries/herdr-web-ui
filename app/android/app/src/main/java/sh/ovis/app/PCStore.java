package sh.ovis.app;

import android.content.Context;
import android.content.SharedPreferences;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;

/**
 * The PCs this app knows, kept in SharedPreferences, as PCStore in the iOS app keeps them in
 * UserDefaults. The WebView's cookies (a paired device's sign-in) live in its own store.
 */
final class PCStore {
    private static final String PREFS = "herdr";

    /** The address to open instead of the bare origin until a PC page loads: a pairing link keeps its code through Try again. In memory only, as it can hold that code. */
    static String pendingStart;

    /** Why the PC's page failed, for the error page: WebView's reason, or the HTTP status it answered. */
    static volatile String failure;

    private PCStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Origins opened before, the latest first. */
    static List<String> saved(Context context) {
        List<String> list = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString("saved", "[]"));
            for (int i = 0; i < array.length(); i++) list.add(array.getString(i));
        } catch (org.json.JSONException ignored) {
            // a damaged list starts empty again
        }
        return list;
    }

    private static void setSaved(Context context, List<String> list) {
        prefs(context).edit().putString("saved", new JSONArray(list).toString()).apply();
    }

    /** The PC the app opens at launch, an origin; null shows the connect screen. */
    static String current(Context context) {
        return prefs(context).getString("current", null);
    }

    static void setCurrent(Context context, String origin) {
        prefs(context).edit().putString("current", origin).apply();
    }

    /** The PC opened last, even after Change PC, for the pages that name it. */
    static String last(Context context) {
        return prefs(context).getString("last", null);
    }

    /** Makes origin the PC to open; it joins the saved PCs only once a page of it loads (remember). */
    static void open(Context context, String origin, String start) {
        prefs(context).edit().putString("current", origin).putString("last", origin).apply();
        pendingStart = start;
    }

    /** Puts origin first in the saved PCs: a page of it has loaded, so an address that never answered is not kept. */
    static void remember(Context context, String origin) {
        List<String> list = saved(context);
        list.remove(origin);
        list.add(0, origin);
        setSaved(context, list);
    }

    static void forget(Context context, String origin) {
        List<String> list = saved(context);
        list.remove(origin);
        setSaved(context, list);
        SharedPreferences.Editor edit = prefs(context).edit();
        if (origin.equals(current(context))) edit.remove("current");
        if (origin.equals(last(context))) edit.remove("last");
        edit.apply();
    }

    /** scheme://host[:port] of a well-formed http or https address, the host in lowercase, or null: `http://pc:abc/` is refused, not saved for Capacitor to fail on at the next start. */
    static String origin(String text) {
        URI uri;
        try {
            uri = new URI(text).parseServerAuthority();
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = uri.getScheme() == null ? null : uri.getScheme().toLowerCase();
        String host = uri.getHost() == null ? null : uri.getHost().toLowerCase(Locale.ROOT);
        if (scheme == null || !(scheme.equals("http") || scheme.equals("https")) || host == null || host.isEmpty()) return null;
        return uri.getPort() == -1 ? scheme + "://" + host : scheme + "://" + host + ":" + uri.getPort();
    }
}
