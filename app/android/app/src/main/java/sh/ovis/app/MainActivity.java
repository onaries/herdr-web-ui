package sh.ovis.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.WebViewListener;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;

/**
 * Capacitor's activity with the chosen PC as the WebView's first page, as HerdrBridgeViewController
 * does on iOS: opening or leaving a PC starts the activity again (reopen), so the next page is a
 * first load too.
 */
public class MainActivity extends BridgeActivity {
    /** Whether the page itself (not a picture or a frame in it) failed since it started. */
    private boolean pageFailed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HerdrShellPlugin.class);
        String origin = PCStore.current(this);
        String host = origin == null ? null : Uri.parse(origin).getHost();
        if (host != null) {
            boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            // Capacitor makes server.url the bridge's origin rule, which takes no path, query or
            // trailing slash: such a rule throws, and Capacitor falls back to a bridge that every
            // frame (a preview's iframe included) can call. So server.url is the bare origin, and a
            // pairing link's path and query come in as the start path until a PC page has loaded.
            config = new CapConfig.Builder(this)
                .setServerUrl(origin)
                .setStartPath(startPath(PCStore.pendingStart, origin))
                // No allowNavigation: the PC's own links (its host and scheme, any port) stay in the
                // WebView already, and Capacitor turns each entry into another bridge origin rule
                // (https://host, or a host starting with "http" as is: invalid, which again drops the
                // bridge's origin check). Other links go to the browser.
                .setErrorPath("error.html")
                .setWebContentsDebuggingEnabled(debuggable)
                .setLoggingEnabled(debuggable)
                .create();
        }
        super.onCreate(savedInstanceState);
        if (host != null) {
            // Capacitor injects its bridge only into the PC's origin, so error.html (served from the
            // app while a PC is open) reaches the app through this listener instead. It answers only
            // the app's own origin in the main frame: a PC page or a frame it opens gets nothing.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                String appOrigin = bridge.getScheme() + "://" + bridge.getHost();
                WebViewCompat.addWebMessageListener(
                    bridge.getWebView(),
                    "HerdrErrorPage",
                    Collections.singleton(appOrigin),
                    (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (!isMainFrame) return;
                        String asked = message.getData();
                        if ("last".equals(asked)) {
                            String last = PCStore.last(this);
                            replyProxy.postMessage(last == null ? "" : last);
                        } else if ("retry".equals(asked)) {
                            reopen();
                        } else if ("changePc".equals(asked)) {
                            PCStore.setCurrent(this, null);
                            reopen();
                        }
                    }
                );
            }
            // Capacitor tells its listeners of every failed request, a picture or a frame included, and
            // not which one: only a failure of the page itself keeps the PC out of the saved list.
            bridge.setWebViewClient(
                new BridgeWebViewClient(bridge) {
                    @Override
                    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                        if (request.isForMainFrame()) pageFailed = true;
                        super.onReceivedError(view, request, error);
                    }
                }
            );
            bridge.addWebViewListener(
                new WebViewListener() {
                    @Override
                    public void onPageStarted(WebView webView) {
                        pageFailed = false;
                    }

                    @Override
                    public void onPageLoaded(WebView webView) {
                        // Chromium reports a page that failed as loaded too, before the error page;
                        // only a page of this very origin (scheme, host and port) counts
                        String url = webView.getUrl();
                        if (pageFailed || url == null || !origin.equals(PCStore.origin(url))) return;
                        // the PC's page is up: a pairing link has done its work, and the PC is one worth keeping
                        PCStore.pendingStart = null;
                        PCStore.remember(MainActivity.this, origin);
                    }
                }
            );
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // WebView writes cookies to disk on its own schedule: a paired device's sign-in set a moment
        // ago would be lost if the app were swiped away now
        CookieManager.getInstance().flush();
    }

    /** The path and query of a pairing link on `origin`, else the PC's root. */
    static String startPath(String start, String origin) {
        if (start == null || !origin.equals(PCStore.origin(start))) return "/";
        Uri uri = Uri.parse(start);
        String path = uri.getEncodedPath();
        String query = uri.getEncodedQuery();
        String fragment = uri.getEncodedFragment();
        return (path == null || path.isEmpty() ? "/" : path) + (query == null ? "" : "?" + query) + (fragment == null ? "" : "#" + fragment);
    }

    /** Starts this activity again, so the next page (a PC, or the connect screen) is a first load. */
    void reopen() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        finish();
        overridePendingTransition(0, 0);
        startActivity(intent);
    }
}
