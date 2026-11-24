package com.killerx.yt

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.webkit.WebView

/**
 * Custom WebView that keeps YouTube media decoding & audio running smoothly
 * in background & screen-off mode, while preserving full keyboard & touch focus.
 */
class KillerXWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = android.R.attr.webViewStyle
) : WebView(context, attrs, defStyleAttr) {

    @Volatile
    var backgroundPlayEnabled: Boolean = true

    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        if (backgroundPlayEnabled && visibility != View.VISIBLE) {
            super.onWindowVisibilityChanged(View.VISIBLE)
        } else {
            super.onWindowVisibilityChanged(visibility)
        }
    }
}
