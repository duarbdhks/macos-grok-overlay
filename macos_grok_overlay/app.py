# Python libraries
import os
import sys

# Apple libraries
import objc
from AppKit import *
from WebKit import *
from Quartz import *
from AVFoundation import AVCaptureDevice, AVMediaTypeAudio
from Foundation import NSObject, NSURL, NSURLRequest, NSDate

# Local libraries
from .constants import (
    APP_TITLE,
    CORNER_RADIUS,
    DRAG_AREA_HEIGHT,
    LOGO_BLACK_PATH,
    LOGO_WHITE_PATH,
    FRAME_SAVE_NAME,
    STATUS_ITEM_CONTEXT,
    WEBSITE,
    LAUNCHER_TRIGGER,
    INTERNAL_HOSTS,
)
from .launcher import (
    install_startup,
    uninstall_startup,
)
from .listener import (
    global_show_hide_listener,
    load_custom_launcher_trigger,
    set_custom_launcher_trigger,
)


# Custom window (contains entire application).
class AppWindow(NSWindow):
    # Explicitly allow key window status
    def canBecomeKeyWindow(self):
        return True

    # Required to capture "Command+..." sequences.
    def keyDown_(self, event):
        self.delegate().keyDown_(event)


# Custom view (contains click-and-drag area on top sliver of overlay).
class DragArea(NSView):
    def initWithFrame_(self, frame):
        objc.super(DragArea, self).initWithFrame_(frame)
        self.setWantsLayer_(True)
        return self
    
    # Used to update top-bar background to (roughly) match app color.
    def setBackgroundColor_(self, color):
        self.layer().setBackgroundColor_(color.CGColor())

    # Used to capture the click-and-drag event.
    def mouseDown_(self, event):
        self.window().performWindowDragWithEvent_(event)


# The main delegate for running the overlay app.
class AppDelegate(NSObject):
    # The main application setup.
    def applicationDidFinishLaunching_(self, notification):
        # Run as accessory app
        NSApp.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
        # Create a borderless, floating, resizable window
        self.window = AppWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            NSMakeRect(500, 200, 550, 580),
            NSWindowStyleMaskBorderless | NSWindowStyleMaskResizable,
            # NSBorderlessWindowMask | NSResizableWindowMask,  # Worked BEFORE Tahoe update
            NSBackingStoreBuffered,
            False
        )
        self.window.setCollectionBehavior_(
            NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorStationary
        )
        # Save the last position and size
        self.window.setFrameAutosaveName_(FRAME_SAVE_NAME)
        # Create the webview for the main application.
        config = WKWebViewConfiguration.alloc().init()
        config.preferences().setJavaScriptCanOpenWindowsAutomatically_(True)
        config.preferences().setValue_forKey_(True, "mediaDevicesEnabled")
        # Initialize the WebView with a frame
        self.webview = WKWebView.alloc().initWithFrame_configuration_(
            ((0, 0), (800, 600)),  # Frame: origin (0,0), size (800x600)
            config
        )
        self.webview.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)  # Resizes with window
        # Set a custom user agent
        safari_user_agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
        self.webview.setCustomUserAgent_(safari_user_agent)
        # Attach delegates for navigation policy (external links) and UI (popups/target=_blank)
        self.webview.setNavigationDelegate_(self)
        self.webview.setUIDelegate_(self)
        # Make window transparent so that the corners can be rounded
        self.window.setOpaque_(False)
        self.window.setBackgroundColor_(NSColor.clearColor())
        # Set up content view with rounded corners
        content_view = NSView.alloc().initWithFrame_(self.window.contentView().bounds())
        content_view.setWantsLayer_(True)
        content_view.layer().setCornerRadius_(CORNER_RADIUS)
        content_view.layer().setBackgroundColor_(NSColor.whiteColor().CGColor())
        self.window.setContentView_(content_view)
        # Set up drag area (top sliver, full width)
        content_bounds = content_view.bounds()
        self.drag_area = DragArea.alloc().initWithFrame_(
            NSMakeRect(0, content_bounds.size.height - DRAG_AREA_HEIGHT, content_bounds.size.width, DRAG_AREA_HEIGHT)
        )
        content_view.addSubview_(self.drag_area)
        # Add close button to the drag area
        close_button = NSButton.alloc().initWithFrame_(NSMakeRect(5, 5, 20, 20))
        close_button.setBordered_(False)
        close_button.setImage_(NSImage.imageWithSystemSymbolName_accessibilityDescription_("xmark.circle.fill", None))
        close_button.setTarget_(self)
        close_button.setAction_("hideWindow:")
        self.drag_area.addSubview_(close_button)
        # Update the webview sizinug and insert it below drag area.
        content_view.addSubview_(self.webview)
        self.webview.setFrame_(NSMakeRect(0, 0, content_bounds.size.width, content_bounds.size.height - DRAG_AREA_HEIGHT))
        # Contat the target website.
        url = NSURL.URLWithString_(WEBSITE)
        request = NSURLRequest.requestWithURL_(url)
        self.webview.loadRequest_(request)
        # Set up script message handler for background color changes
        configuration = self.webview.configuration()
        user_content_controller = configuration.userContentController()
        user_content_controller.addScriptMessageHandler_name_(self, "backgroundColorHandler")
        user_content_controller.addScriptMessageHandler_name_(self, "hideHandler")
        # Inject JavaScript to monitor background color changes
        script = """
            (function(){
                try {
                    if (typeof Notification === 'undefined') { window.Notification = function(){}; }
                    Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
                    Notification.requestPermission = function(cb){
                        const r = 'granted';
                        if (typeof cb === 'function') cb(r);
                        return Promise.resolve(r);
                    };
                } catch(e){}
            })();
            function _post(bg){try{const h=window.webkit?.messageHandlers?.backgroundColorHandler;h&&h.postMessage(bg);}catch(e){}}
            function _getColor(el){if(!el) return null; const c=getComputedStyle(el).backgroundColor; return (!c||c==='rgba(0, 0, 0, 0)'||c==='transparent')?null:c;}
            function sendBackgroundColor(){
                const bg=_getColor(document.body)||_getColor(document.documentElement)||'rgb(255,255,255)';
                _post(bg);
            }
            document.addEventListener('DOMContentLoaded', sendBackgroundColor);
            window.addEventListener('load', sendBackgroundColor);
            new MutationObserver(sendBackgroundColor).observe(document.documentElement,{attributes:true,attributeFilter:['style'],subtree:true,childList:true});
        """
        user_script = WKUserScript.alloc().initWithSource_injectionTime_forMainFrameOnly_(script, WKUserScriptInjectionTimeAtDocumentEnd, True)
        user_content_controller.addUserScript_(user_script)
        # Inject Vimium-like keybindings shim
        try:
            _pkg_dir = os.path.dirname(os.path.abspath(__file__))
            with open(os.path.join(_pkg_dir, "vimium_shim.js"), "r") as _vf:
                _vim_src = _vf.read()
            _vim_script = WKUserScript.alloc().initWithSource_injectionTime_forMainFrameOnly_(
                _vim_src, WKUserScriptInjectionTimeAtDocumentEnd, False
            )
            user_content_controller.addUserScript_(_vim_script)
        except Exception as _e:
            print(f"Failed to inject Vimium shim: {_e}", flush=True)

        # Inject Cmd+F find-in-page shim (separate from vimium for maintainability)
        try:
            _pkg_dir = os.path.dirname(os.path.abspath(__file__))
            with open(os.path.join(_pkg_dir, "find_shim.js"), "r") as _ff:
                _find_src = _ff.read()
            _find_script = WKUserScript.alloc().initWithSource_injectionTime_forMainFrameOnly_(
                _find_src, WKUserScriptInjectionTimeAtDocumentEnd, False
            )
            user_content_controller.addUserScript_(_find_script)
        except Exception as _e:
            print(f"Failed to inject Find shim: {_e}", flush=True)
        # Create status bar item with logo
        self.status_item = NSStatusBar.systemStatusBar().statusItemWithLength_(NSSquareStatusItemLength)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        logo_white_path = os.path.join(script_dir, LOGO_WHITE_PATH)
        self.logo_white = NSImage.alloc().initWithContentsOfFile_(logo_white_path)
        self.logo_white.setSize_(NSSize(18, 18))
        logo_black_path = os.path.join(script_dir, LOGO_BLACK_PATH)
        self.logo_black = NSImage.alloc().initWithContentsOfFile_(logo_black_path)
        self.logo_black.setSize_(NSSize(18, 18))
        # Set the initial logo image based on the current appearance
        self.updateStatusItemImage()
        # Observe system appearance changes
        self.status_item.button().addObserver_forKeyPath_options_context_(
            self, "effectiveAppearance", NSKeyValueObservingOptionNew, STATUS_ITEM_CONTEXT
        )
        # Create status bar menu
        menu = NSMenu.alloc().init()
        # Create and configure menu items with explicit targets
        show_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Show "+APP_TITLE, "showWindow:", "")
        show_item.setTarget_(self)
        menu.addItem_(show_item)
        hide_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Hide "+APP_TITLE, "hideWindow:", "h")
        hide_item.setTarget_(self)
        menu.addItem_(hide_item)
        home_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Home", "goToWebsite:", "g")
        home_item.setTarget_(self)
        menu.addItem_(home_item)
        back_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Back", "goBack:", "[")
        back_item.setTarget_(self)
        menu.addItem_(back_item)
        reload_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Reload", "reloadWebView:", "r")
        reload_item.setTarget_(self)
        menu.addItem_(reload_item)
        clear_data_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Clear Web Cache", "clearWebViewData:", "")
        clear_data_item.setTarget_(self)
        menu.addItem_(clear_data_item)
        # Microphone.
        mic_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Request Microphone Access", "requestMicrophoneAccess:", "")
        mic_item.setTarget_(self)
        menu.addItem_(mic_item)
        # Intall / uninstall autolauncher.
        install_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Install Autolauncher", "install:", "")
        install_item.setTarget_(self)
        menu.addItem_(install_item)
        uninstall_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Uninstall Autolauncher", "uninstall:", "")
        uninstall_item.setTarget_(self)
        menu.addItem_(uninstall_item)
        # ----------------------------------------
        menu.addItem_(NSMenuItem.separatorItem())
        # Trigger.
        set_trigger_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Set New Trigger", "setTrigger:", "")
        set_trigger_item.setTarget_(self)
        menu.addItem_(set_trigger_item)
        trigger_label = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Current Trigger", "", "")
        trigger_label.setEnabled_(False)
        menu.addItem_(trigger_label)
        self.trigger_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("", "", "")
        self.trigger_item.setEnabled_(False)
        menu.addItem_(self.trigger_item)
        menu.addItem_(NSMenuItem.separatorItem())
        # ----------------------------------------
        # Quit.
        quit_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Quit", "terminate:", "q")
        quit_item.setTarget_(NSApp)
        menu.addItem_(quit_item)
        # Set the menu for the status item
        self.status_item.setMenu_(menu)
        # Add resize observer
        NSNotificationCenter.defaultCenter().addObserver_selector_name_object_(
            self, 'windowDidResize:', NSWindowDidResizeNotification, self.window
        )
        # Add local mouse event monitor for left mouse down
        self.local_mouse_monitor = NSEvent.addLocalMonitorForEventsMatchingMask_handler_(
            NSEventMaskLeftMouseDown,  # Monitor left mouse-down events
            self.handleLocalMouseEvent  # Handler method
        )
        # Add local key event monitor for reliable Cmd shortcuts (even when WKWebView is first responder)
        self.local_key_monitor = NSEvent.addLocalMonitorForEventsMatchingMask_handler_(
            NSEventMaskKeyDown,
            self.handleLocalKeyEvent
        )
        # Create the event tap for key-down events
        tap = CGEventTapCreate(
            kCGSessionEventTap, # Tap at the session level
            kCGHeadInsertEventTap, # Insert at the head of the event queue
            kCGEventTapOptionDefault, # Actively filter events
            CGEventMaskBit(kCGEventKeyDown), # Capture key-down events
            global_show_hide_listener(self), # Your callback function
            None # Optional user info (refcon)
        )
        if tap:
            # Integrate the tap into the run loop
            source = CFMachPortCreateRunLoopSource(None, tap, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes)
            CGEventTapEnable(tap, True)
            # CFRunLoopRun() # Start the run loop (causes HANG as of Tahoe)
        else:
            print("Failed to create event tap. Check Accessibility permissions.")
        # Load the custom launch trigger if the user set it.
        load_custom_launcher_trigger(self)
        # Set the delegate of the window to this parent application.
        self.window.setDelegate_(self)
        # Make sure this window is shown and focused.
        self.showWindow_(None)

    # Logic to show the overlay, make it the key window, and focus on the typing area.
    def showWindow_(self, sender):
        self.window.setAlphaValue_(0.0)
        self.window.orderFront_(None)
        NSApp.activateIgnoringOtherApps_(True)
        def _fadeIn(ctx):
            ctx.setDuration_(0.18)
            self.window.animator().setAlphaValue_(1.0)
        def _afterFadeIn():
            self.window.makeKeyWindow()
            self.webview.evaluateJavaScript_completionHandler_(
                "[...document.querySelectorAll('textarea')].sort((a,b)=>a.contains(b)?-1:b.contains(a)?1:0).pop()?.focus();",
                None
            )
        NSAnimationContext.runAnimationGroup_completionHandler_(_fadeIn, _afterFadeIn)

    # Hide the overlay and allow focus to return to the next visible application.
    def hideWindow_(self, sender):
        def _fadeOut(ctx):
            ctx.setDuration_(0.15)
            self.window.animator().setAlphaValue_(0.0)
        def _done():
            self.window.orderOut_(None)
            self.window.setAlphaValue_(1.0)
        NSAnimationContext.runAnimationGroup_completionHandler_(_fadeOut, _done)
    
    # Navigate the webview back one entry, if possible.
    def goBack_(self, sender):
        if self.webview.canGoBack():
            self.webview.goBack()

    # Reload the webview (menu action for Cmd+R; soft reload by default).
    # The keyboard handlers (keyDown_ + local monitor) own the Shift variant for hard reload.
    def reloadWebView_(self, sender):
        self.webview.reload()

    # Go to the default landing website for the overlay (in case accidentally navigated away).
    def goToWebsite_(self, sender):
        url = NSURL.URLWithString_(WEBSITE)
        request = NSURLRequest.requestWithURL_(url)
        self.webview.loadRequest_(request)
    
    # Clear the webview cache data (in case cookies cause errors).
    def clearWebViewData_(self, sender):
        dataStore = self.webview.configuration().websiteDataStore()
        dataTypes = WKWebsiteDataStore.allWebsiteDataTypes()
        dataStore.removeDataOfTypes_modifiedSince_completionHandler_(
            dataTypes,
            NSDate.distantPast(),
            lambda: print("Data cleared")
        )

    # Explicitly request microphone permission from macOS.
    def requestMicrophoneAccess_(self, sender):
        try:
            AVCaptureDevice.requestAccessForMediaType_completionHandler_(
                AVMediaTypeAudio,
                lambda granted: print(f"Microphone access {'granted' if granted else 'denied'}.", flush=True)
            )
        except Exception as e:
            print(f"Failed to request microphone access: {e}", flush=True)

    # Go to the default landing website for the overlay (in case accidentally navigated away).
    def install_(self, sender):
        if install_startup():
            # Exit the current process since a new one will launch.
            print("Installation successful, exiting.", flush=True)
            NSApp.terminate_(None)
        else:
            print("Installation unsuccessful.", flush=True)

    # Go to the default landing website for the overlay (in case accidentally navigated away).
    def uninstall_(self, sender):
        if uninstall_startup():
            NSApp.hide_(None)

    # Handle the 'Set Trigger' menu item click.
    def setTrigger_(self, sender):
        set_custom_launcher_trigger(self)

    def updateTriggerMenu(self, key_string=""):
        self.trigger_item.setTitle_("    " + key_string)

    # Return base key for Cmd/Ctrl shortcuts. Prefers hardware keyCode (IME-proof);
    # falls back to produced char and our explicit Korean jamo map.
    def _normalized_key(self, event, key):
        kc = event.keyCode()
        # complete map for all currently handled letters + '[' + 'r' (keycode primary; 15 = R)
        m = {0: 'a', 8: 'c', 7: 'x', 9: 'v', 4: 'h', 12: 'q', 13: 'w', 33: '[', 15: 'r'}
        if kc in m:
            return m[kc]
        k = (key or '').lower()
        if k in ('a', 'c', 'x', 'v', 'h', 'q', 'w', '[', 'r'):
            return k
        # explicit Korean jamo fallbacks for our shortcuts (defense-in-depth)
        j = {'ㅁ': 'a', 'ㅊ': 'c', 'ㅌ': 'x', 'ㅍ': 'v', 'ㅗ': 'h', 'ㅂ': 'q', 'ㅈ': 'w', 'ㄱ': 'r'}
        if k in j:
            return j[k]
        return k

    # For capturing key commands while the key window (in focus).
    def keyDown_(self, event):
        modifiers = event.modifierFlags()
        key_command = modifiers & NSEventModifierFlagCommand
        key_alt = modifiers & NSEventModifierFlagOption
        key_shift = modifiers & NSEventModifierFlagShift
        key_control = modifiers & NSEventModifierFlagControl
        key = event.charactersIgnoringModifiers()
        # Command (NOT alt)
        if (key_command or key_control) and (not key_alt):
            base = self._normalized_key(event, key)
            # Select all
            if base == 'a':
                self.window.firstResponder().selectAll_(None)
            # Copy
            elif base == 'c':
                self.window.firstResponder().copy_(None)
            # Cut
            elif base == 'x':
                self.window.firstResponder().cut_(None)
            # Paste
            elif base == 'v':
                self.window.firstResponder().paste_(None)
            # Hide
            elif base == 'h':
                self.hideWindow_(None)
            # Hide (Cmd+W; folded into helper; keycode covers Korean 'ㅈ')
            elif base == 'w':
                self.hideWindow_(None)
            # Quit
            elif base == 'q':
                NSApp.terminate_(None)
            # Back (webview history)
            elif base == '[':
                self.goBack_(None)
            # Cmd+F → custom find-in-page (JS handles the UI)
            elif base == 'f':
                self.webview.evaluateJavaScript_completionHandler_(
                    "window.__grokFind && window.__grokFind.open()",
                    None
                )
            # Reload (Cmd+R soft / Cmd+Shift+R hard-from-origin).
            # Mirrors browser default but provides explicit IME-proof path (keyDown_ path).
            elif base == 'r':
                if key_shift:
                    self.webview.reloadFromOrigin()
                else:
                    self.webview.reload()
            # # Undo (causes crash for some reason)
            # elif base == 'z':
            #     self.window.firstResponder().undo_(None)

    # Handler for capturing a click-and-drag event when not already the key window.
    @objc.python_method
    def handleLocalMouseEvent(self, event):
        if event.window() == self.window:
            # Get the click location in window coordinates
            click_location = event.locationInWindow()
            # Use hitTest_ to determine which view receives the click
            hit_view = self.window.contentView().hitTest_(click_location)
            # Check if the hit view is the drag area
            if hit_view == self.drag_area:
                # Bring the window to the front and make it key
                self.showWindow_(None)
                # Initiate window dragging with the event
                self.window.performWindowDragWithEvent_(event)
                return None  # Consume the event
        return event  # Pass unhandled events along

    # Handler for Cmd key shortcuts (W/ㅈ to hide). Uses local monitor so it works
    # even when the WKWebView is the first responder and would otherwise swallow the event.
    @objc.python_method
    def handleLocalKeyEvent(self, event):
        # Only care when our window is the active key window
        if not self.window.isKeyWindow():
            return event

        modifiers = event.modifierFlags()
        has_cmd = modifiers & NSEventModifierFlagCommand
        has_alt = modifiers & NSEventModifierFlagOption
        has_shift = modifiers & NSEventModifierFlagShift

        if has_cmd and not has_alt:
            key = event.charactersIgnoringModifiers()
            base = self._normalized_key(event, key)

            if base == 'w':
                self.hideWindow_(None)
                return None  # consume so WebKit doesn't see it

            # Cmd+F → open custom in-page find bar (everything handled in JS)
            if base == 'f':
                self.webview.evaluateJavaScript_completionHandler_(
                    "window.__grokFind && window.__grokFind.open()",
                    None
                )
                return None  # fully consume so browser find never triggers

            # Cmd+R (soft) / Cmd+Shift+R (hard, bypass cache) → explicit reload.
            # Critical for focused app state (current keyDown_ delegation swallows it).
            if base == 'r':
                if has_shift:
                    self.webview.reloadFromOrigin()
                else:
                    self.webview.reload()
                return None  # consume (like W/F) so it never reaches WebKit/page

        return event

    # Handler for when the window resizes (adjusts the drag area).
    def windowDidResize_(self, notification):
        bounds = self.window.contentView().bounds()
        w, h = bounds.size.width, bounds.size.height
        self.drag_area.setFrame_(NSMakeRect(0, h - DRAG_AREA_HEIGHT, w, DRAG_AREA_HEIGHT))
        self.webview.setFrame_(NSMakeRect(0, 0, w, h - DRAG_AREA_HEIGHT))

    # Handler for setting the background color based on the web page background color.
    def userContentController_didReceiveScriptMessage_(self, userContentController, message):
        if message.name() == "hideHandler":
            self.hideWindow_(None)
            return
        if message.name() == "backgroundColorHandler":
            bg_color_str = message.body()
            # Convert CSS color to NSColor (assuming RGB for simplicity)
            if bg_color_str.startswith("rgb") and ("(" in bg_color_str) and (")" in bg_color_str):
                rgb_values = [float(val) for val in bg_color_str[bg_color_str.index("(")+1:bg_color_str.index(")")].split(",")]
                r, g, b = [val / 255.0 for val in rgb_values[:3]]
                color = NSColor.colorWithCalibratedRed_green_blue_alpha_(r, g, b, 1.0)
                self.drag_area.setBackgroundColor_(color)

    # WKNavigationDelegate: open non-whitelisted links (LinkActivated clicks) in default browser.
    # Internal hosts (SPA nav like New chat) continue inside the overlay.
    def webView_decidePolicyForNavigationAction_decisionHandler_(self, webView, navigationAction, decisionHandler):
        if navigationAction.navigationType() == WKNavigationTypeLinkActivated:
            url = navigationAction.request().URL()
            if url is not None:
                host = (url.host() or "").lower()
                if host not in INTERNAL_HOSTS:
                    NSWorkspace.sharedWorkspace().openURL_(url)
                    decisionHandler(WKNavigationActionPolicyCancel)
                    return
        decisionHandler(WKNavigationActionPolicyAllow)

    # WKUIDelegate: catch target=_blank, window.open(), etc. and open in external browser instead of creating nested WKWebView.
    def webView_createWebViewWithConfiguration_forNavigationAction_windowFeatures_(self, webView, configuration, navigationAction, windowFeatures):
        url = navigationAction.request().URL()
        if url:
            NSWorkspace.sharedWorkspace().openURL_(url)
        return None

    # Logic for checking what color the logo in the status bar should be, and setting appropriate logo.
    def updateStatusItemImage(self):
        appearance = self.status_item.button().effectiveAppearance()
        if appearance.bestMatchFromAppearancesWithNames_([NSAppearanceNameAqua, NSAppearanceNameDarkAqua]) == NSAppearanceNameDarkAqua:
            self.status_item.button().setImage_(self.logo_white)
        else:
            self.status_item.button().setImage_(self.logo_black)

    # Observer that is triggered whenever the color of the status bar logo might need to be updated.
    def observeValueForKeyPath_ofObject_change_context_(self, keyPath, object, change, context):
        if context == STATUS_ITEM_CONTEXT and keyPath == "effectiveAppearance":
            self.updateStatusItemImage()

    # System triggered appearance changes that might affect logo color.
    def appearanceDidChange_(self, notification):
        # Update the logo image when the system appearance changes
        self.updateStatusItemImage()
