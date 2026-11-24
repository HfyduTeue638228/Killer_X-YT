package com.killerx.yt

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.webkit.WebView

/**
 * Custom WebView that keeps YouTube media decoding & audio running smoothly
 * even when the user switches apps (Background Play) or turns off the screen (Screen-Off Play).
 */
class KillerXWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : WebView(context, attrs, defStyleAttr) {

    @Volatile
    var backgroundPlayEnabled: Boolean = true

    override fun onWindowVisibilityChanged(visibility: Int) {
        if (backgroundPlayEnabled && visibility != View.VISIBLE) {
            super.onWindowVisibilityChanged(View.VISIBLE)
        } else {
            super.onWindowVisibilityChanged(visibility)
        }
    }
}
