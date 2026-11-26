// Run with: node --test tests/storefront-auth.test.cjs
// Exercises the actual inline storefront script with in-memory DOM/Clerk/storage/timers.
// These checks do not establish real Clerk, network, or browser behavior.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const product = "GnC Cata's Lumanog Acoustic";
const cachedMember = JSON.stringify({ username: 'Cached Member', isGuest: false });
const cachedGuest = JSON.stringify({ username: 'Cached Guest', isGuest: true });
const legacyAckKey = 'gnc_legacy_shopping_notice_v1';
const v1Key = id => 'gnc_shopping_v1:' + (id ? 'member:' + encodeURIComponent(id) : 'guest');
const ownerKey = id => id ? 'gnc_shopping_v2:member:' + encodeURIComponent(id) : v1Key(null);
const record = (cart = [], purchasedItems = []) => JSON.stringify({ version: 1, cart, purchasedItems });

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function mockClerk(userId = null) {
    const listeners = new Set();
    const clerk = {
        loaded: false, user: null, session: null, loadCalls: 0, subscriptions: 0,
        async load() { this.loadCalls++; this.loaded = true; },
        addListener(callback) {
            this.subscriptions++;
            listeners.add(callback);
            callback({ user: this.user, session: this.session });
            return () => listeners.delete(callback);
        },
        emit() { for (const callback of [...listeners]) callback({ user: this.user, session: this.session }); },
        member(id, notify = true) {
            this.user = id ? { id, firstName: id, primaryEmailAddress: { emailAddress: id + '@example.test' } } : null;
            this.session = id ? { id: 'session_' + id, user: this.user, status: 'active', expireAt: new Date(Date.now() + 60000) } : null;
            if (notify) this.emit();
        },
        async signOut() { this.member(null); },
        listeners
    };
    clerk.member(userId, false);
    return clerk;
}

function boot({ clerk = mockClerk(), profile, cart = [product], storage = { [v1Key(clerk?.user?.id)]: record(cart) }, faults = {} } = {}) {
    if (profile !== undefined) storage.gnc_user = profile;
    const operations = [];
    function access(operation, key) {
        operations.push({ operation, key });
        if (faults[operation] === true || faults[operation] === key) throw new Error('Storage unavailable');
    }
    const nodes = new Map(), elements = new Set(), timers = new Map(), intervals = new Map();
    const documentEvents = new Map();
    let timerId = 0;

    function element(tagName = 'div', attrs = '') {
        const classes = new Set();
        const events = new Map();
        const attributes = new Map([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
        const node = {
            tagName, id: '', style: {}, children: [], hidden: /\bhidden\b/.test(attrs),
            inert: /\binert\b/.test(attrs),
            disabled: /\bdisabled\b/.test(attrs), value: '', _text: '', _html: '',
            classList: {
                add(...names) { names.forEach(name => classes.add(name)); },
                remove(...names) { names.forEach(name => classes.delete(name)); },
                contains(name) { return classes.has(name); },
                toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); }
            },
            get className() { return [...classes].join(' '); },
            set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
            get textContent() { return this._text; },
            set textContent(value) { this._text = String(value); this._html = ''; this.children = []; },
            get innerHTML() { return this._html || this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;'); },
            set innerHTML(value) {
                this.children.forEach(child => child.remove());
                this.children = []; this._html = value; this._text = '';
                for (const match of value.matchAll(/<button\b([^>]*)>/g)) this.appendChild(element('button', match[1]));
            },
            appendChild(child) { this.children.push(child); child.parent = this; if (child.id) nodes.set(child.id, child); },
            remove() {
                [...this.children].forEach(child => child.remove()); elements.delete(this); if (this.id) nodes.delete(this.id);
                if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
            },
            addEventListener(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
            removeEventListener(name, callback) { events.get(name)?.delete(callback); },
            dispatch(name) { for (const callback of [...(events.get(name) || [])]) callback(); },
            listenerCount(name) { return events.get(name)?.size || 0; },
            setAttribute(name, value) { attributes.set(name, value); },
            getAttribute(name) { return attributes.get(name) ?? null; },
            focus() { document.activeElement = this; },
            scrollIntoView(options) { this.lastScroll = options; }
        };
        node.id = attrs.match(/\bid="([^"]+)"/)?.[1] || '';
        node.className = attrs.match(/\bclass="([^"]+)"/)?.[1] || '';
        elements.add(node);
        if (node.id) nodes.set(node.id, node);
        return node;
    }
    for (const match of html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
        element(match[1], match[2]);
    }
    // The external script was removed above along with its contents.
    element('script', 'id="clerk-script"');
    const matches = (node, selector) => selector.startsWith('#') ? node.id === selector.slice(1)
        : selector.startsWith('.') && selector.slice(1).split('.').every(name => node.classList.contains(name));
    const document = {
        body: element('body'), getElementById: id => nodes.get(id) || null,
        createElement: tag => element(tag),
        querySelectorAll: selector => [...elements].filter(node => selector.split(',').some(s => matches(node, s.trim()))),
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        dispatch(name, event) { for (const callback of documentEvents.get(name) || []) callback(event); },
        addEventListener(name, callback) { if (!documentEvents.has(name)) documentEvents.set(name, []); documentEvents.get(name).push(callback); }
    };
    const location = { href: 'index.html', replacements: [], reloads: 0,
        replace(url) { this.href = url; this.replacements.push(url); }, reload() { this.reloads++; } };
    const window = { Clerk: clerk, location };
    let now = Date.now();
    class Clock extends Date { static now() { return now; } }
    const context = vm.createContext({
        Date: Clock,
        document, window, console: { warn() {}, error() {}, log() {} },
        localStorage: {
            getItem(key) { access('read', key); return storage[key] ?? null; },
            setItem(key, value) { access('write', key); storage[key] = value; },
            removeItem(key) { access('remove', key); delete storage[key]; }
        },
        setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
        setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id; }, clearInterval: id => intervals.delete(id)
    });
    vm.runInContext(source, context, { filename: 'index.html' });
    for (const callback of documentEvents.get('DOMContentLoaded') || []) callback();
    return {
        clerk, storage, document, location, intervals, timers, faults, operations, get: id => nodes.get(id),
        advance(ms) { now += ms; },
        run: code => vm.runInContext(code, context),
        async settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); },
        timeout(ms = 12000) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
        fill() { for (const [id, value] of Object.entries({ name: 'Test Customer', address: 'Demo address', cellphone: '09123456789' })) nodes.get(id).value = value; },
        storedShopping() { return JSON.stringify(Object.fromEntries(Object.entries(storage).filter(([key]) => key.startsWith('gnc_shopping_') || key === 'gnc_cart' || key === 'gnc_purchased'))); },
        shopping() { return JSON.stringify({ cart: this.run('cart'), earlier: this.run('earlierPurchases'), orders: this.run('orders'), stored: this.storedShopping() }); },
        toasts() {
            const content = node => node.textContent + node.children.map(content).join('');
            return nodes.get('toast-container').children.map(content).join('\n');
        }
    };
}

function assertRejected(app, attempt) {
    const before = app.shopping();
    app.run(attempt);
    assert.equal(app.shopping(), before, 'rejected purchase must preserve all cart/purchase data');
}

for (const profile of [undefined, cachedMember, '{invalid', 'null', '[]', '"member"']) {
    test('no active session redirects regardless of cache: ' + String(profile), async () => {
        const app = boot({ profile }); await app.settle();
        assert.equal(app.run('authState'), 'unauthenticated');
        assert.equal(app.location.href, 'login.html');
        assert.equal(app.storage.gnc_user, undefined);
        assertRejected(app, 'buyNow(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
    });
}

test('explicit guest can manage cart and sees the existing account gate for every purchase entry', async () => {
    const app = boot({ profile: cachedGuest }); await app.settle();
    assert.equal(app.run('authState'), 'guest'); assert.equal(app.location.href, 'index.html');
    app.run('addToCart(guitarDatabase[1].name); removeFromCart(0)');
    assert.equal(app.run('cart.length'), 1);
    for (const attempt of ['buyNow(guitarDatabase[0].name)', 'checkoutCart()', 'proceedPurchase()']) {
        assertRejected(app, attempt); assert.equal(app.get('guest-gate-modal').style.display, 'block');
        assert.notEqual(app.get('buy-now-modal').style.display, 'block');
    }
});

test('active member takes precedence over cached guest and updates all display text safely', async () => {
    const clerk = mockClerk('member_a'); clerk.user.firstName = '<img src=x onerror=alert(1)>';
    const app = boot({ clerk, profile: cachedGuest }); await app.settle();
    assert.equal(app.run('authState'), 'member');
    assert.equal(JSON.parse(app.storage.gnc_user).isGuest, false);
    assert.equal(app.get('welcome-title').textContent, 'Welcome, <img src=x onerror=alert(1)>!');
    assert.equal(app.get('dropdown-username').textContent, clerk.user.firstName);
    assert.equal(app.get('dropdown-role').textContent, 'Member');
    assert.equal(app.get('welcome-title').children.length, 0);
    assert.equal(app.get('auth-notice').hidden, true);
});

for (const invalid of ['missing session', 'missing user', 'pending', 'expired', 'wrong user', 'past expiry']) {
    test('incomplete/inactive Clerk identity cannot purchase: ' + invalid, async () => {
        const clerk = mockClerk('member_a');
        if (invalid === 'missing session') clerk.session = null;
        if (invalid === 'missing user') clerk.user = null;
        if (invalid === 'pending' || invalid === 'expired') clerk.session.status = invalid;
        if (invalid === 'wrong user') clerk.session.user = { id: 'other_user' };
        if (invalid === 'past expiry') clerk.session.expireAt = new Date(0);
        const app = boot({ clerk, profile: cachedMember }); await app.settle();
        assert.equal(app.run('authState'), 'unauthenticated');
        assertRejected(app, 'buyNow(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
    });
}

test('initializing auth hides saved data and pauses cart and purchase calls; browsing remains available', async () => {
    const waiting = deferred(), clerk = mockClerk('member_a');
    clerk.load = () => waiting.promise;
    const app = boot({ clerk }); await app.settle();
    assert.equal(app.run('authState'), 'initializing');
    app.fill(); assertRejected(app, 'buyNow(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
    assertRejected(app, 'addToCart(guitarDatabase[1].name); removeFromCart(0); applyCoupon()');
    assert.equal(app.run('cart.length'), 0);
    for (const button of app.document.querySelectorAll('.btn-buy-now, .btn-add-cart, .cart-checkout-btn, #purchase-submit, #apply-coupon-btn')) assert.equal(button.disabled, true);
    assert.match(app.get('guitar-grid').innerHTML, /GnC Cata/);
    assert.equal(app.get('search-input').disabled, false);
    assert.equal(app.get('auth-notice').hidden, false);
});

test('initialization rejection blocks purchase and retry recovers with one listener', async () => {
    const clerk = mockClerk('member_a'); clerk.load = async () => { throw new Error('offline'); };
    const app = boot({ clerk }); await app.settle();
    assert.equal(app.run('authState'), 'error'); assert.equal(app.get('auth-retry-btn').hidden, false);
    app.fill(); assertRejected(app, 'buyNow(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
    clerk.load = async () => { clerk.loaded = true; };
    await app.get('auth-retry-btn').onclick(); await app.settle();
    assert.equal(app.run('authState'), 'member'); assert.equal(clerk.listeners.size, 1);
    await app.run('initializeAuthentication()'); await app.run('initializeAuthentication()');
    assert.equal(clerk.listeners.size, 1);
});

for (const failure of ['script error', 'missing global', 'stalled script']) {
    test('SDK failure has bounded feedback and reload retry: ' + failure, async () => {
        const app = boot({ clerk: null }); await app.settle();
        const script = app.get('clerk-script');
        if (failure === 'script error') script.dispatch('error');
        if (failure === 'missing global') script.dispatch('load');
        if (failure === 'stalled script') app.timeout();
        await app.settle(); assert.equal(app.run('authState'), 'error');
        assert.equal(script.listenerCount('load'), 0); assert.equal(script.listenerCount('error'), 0);
        assertRejected(app, 'buyNow(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
        app.get('auth-retry-btn').onclick(); assert.equal(app.location.reloads, 1);
    });
}

test('a timed-out load cannot authorize later; retry and concurrent retry keep one listener', async () => {
    const waiting = deferred(), clerk = mockClerk('member_a'); clerk.load = () => waiting.promise;
    const app = boot({ clerk }); await app.settle(); app.timeout(); await app.settle();
    assert.equal(app.run('authState'), 'error');
    clerk.loaded = true; waiting.resolve(); await app.settle();
    assert.equal(app.run('authState'), 'error'); assert.equal(clerk.listeners.size, 0);
    app.run('initializeAuthentication(); initializeAuthentication()'); await app.settle();
    assert.equal(app.run('authState'), 'member'); assert.equal(clerk.listeners.size, 1); assert.equal(clerk.subscriptions, 1);
});

for (const change of ['sign out', 'expiration', 'account switch', 'session switch']) {
    test('session change closes and invalidates open checkout: ' + change, async () => {
        const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle();
        app.run('checkoutCart()'); app.fill();
        const before = app.storedShopping();
        if (change === 'sign out') clerk.member(null);
        if (change === 'expiration') { clerk.session.status = 'expired'; clerk.emit(); }
        if (change === 'account switch') clerk.member('member_b');
        if (change === 'session switch') { clerk.session.id = 'new_session'; clerk.emit(); }
        assert.equal(app.get('buy-now-modal').style.display, 'none');
        assert.equal(app.get('overlay').style.display, 'none'); assert.equal(app.get('name').value, '');
        assert.equal(app.run('checkoutIdentity'), null);
        assertRejected(app, 'proceedPurchase()'); assert.equal(app.storedShopping(), before);
        assert.equal(app.run('cart.length'), change === 'session switch' ? 1 : 0);
        if (change === 'account switch') assert.equal(app.get('dropdown-username').textContent, 'member_b');
    });
}

test('submission detects silent identity changes even without a listener emission', async () => {
    const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle();
    app.run('checkoutCart()'); app.fill(); clerk.member('member_b', false);
    const before = app.storedShopping(); app.run('proceedPurchase()');
    assert.equal(app.storedShopping(), before); assert.equal(app.run('checkoutIdentity'), null);
    assert.equal(app.run('cart.length'), 0);
});

test('identity is checked again after field validation and before any shopping mutation', async () => {
    const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle();
    app.run('checkoutCart()'); app.fill();
    let value = 'Test Customer';
    Object.defineProperty(app.get('name'), 'value', {
        get() { clerk.member('member_b', false); return value; }, set(next) { value = next; }
    });
    const before = app.storedShopping(); app.run('proceedPurchase()');
    assert.equal(app.storedShopping(), before); assert.equal(app.run('cart.length'), 0);
});

test('direct submission without an open checkout is rejected even for a member', async () => {
    const app = boot({ clerk: mockClerk('member_a') }); await app.settle(); app.fill();
    assertRejected(app, 'proceedPurchase()');
});

for (const mode of ['buy now', 'cart']) {
    test('successful member checkout preserves existing shopping flow: ' + mode, async () => {
        const app = boot({ clerk: mockClerk('member_a') }); await app.settle();
        app.run(mode === 'cart' ? 'checkoutCart()' : 'buyNow(guitarDatabase[0].name)'); app.fill();
        app.run('proceedPurchase()');
        assert.equal(app.run('orders.length'), 1);
        assert.equal(JSON.parse(app.storage[ownerKey('member_a')]).orders[0].items[0].name, product);
        assert.equal(app.run('cart.length'), mode === 'cart' ? 0 : 1);
        assert.equal(app.get('confirmed-address').textContent, 'Demo address');
        assert.equal(app.get('confirmation-modal').style.display, 'block');
        assert.equal(app.intervals.size, 1); assert.equal(app.run('checkoutIdentity'), null);
        assertRejected(app, 'proceedPurchase()');
    });
}

test('failed sign-out retains member/cache, reports no success, and supports retry', async () => {
    const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle();
    const oldProfile = app.storage.gnc_user; app.run('checkoutCart()'); app.fill();
    clerk.signOut = async () => { throw new Error('offline'); };
    const before = app.shopping(); await app.run('logoutUser()');
    assert.equal(app.shopping(), before); assert.equal(app.storage.gnc_user, oldProfile);
    assert.equal(app.run('authState'), 'member'); assert.equal(app.run('checkoutIdentity'), null);
    assert.equal(app.location.href, 'index.html'); assert.doesNotMatch(app.toasts(), /Logged out successfully/);
    assert.equal(app.get('auth-message').textContent, 'We couldn’t confirm sign-out. Please try again.');
    clerk.signOut = async () => { clerk.member(null); };
    await app.get('auth-retry-btn').onclick();
    assert.equal(app.location.href, 'login.html'); assert.equal(app.storage.gnc_user, undefined);
    assert.match(app.toasts(), /Logged out successfully/);
});

test('sign-out in progress blocks purchases and a hung sign-out remains recoverable', async () => {
    const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle();
    clerk.signOut = () => new Promise(() => {});
    const pending = app.run('logoutUser()'); app.fill();
    assertRejected(app, 'buyNow(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
    app.timeout(); await app.settle(); await pending;
    assert.equal(app.location.href, 'index.html'); assert.equal(app.get('auth-retry-btn').hidden, false);
    assert.doesNotMatch(app.toasts(), /Logged out successfully/);
});

test('malformed profile does not break an authenticated member', async () => {
    const app = boot({ clerk: mockClerk('member_a'), profile: '{invalid' }); await app.settle();
    assert.equal(app.run('authState'), 'member'); assert.equal(JSON.parse(app.storage.gnc_user).isGuest, false);
});

test('signed-in member replaces guest gate without leaving a blocking overlay', async () => {
    const clerk = mockClerk(), app = boot({ clerk, profile: cachedGuest }); await app.settle();
    app.run('checkoutCart()'); assert.equal(app.get('guest-gate-modal').style.display, 'block');
    clerk.member('member_a');
    assert.equal(app.get('guest-gate-modal').style.display, 'none'); assert.equal(app.get('overlay').style.display, 'none');
    assert.equal(app.get('dropdown-role').textContent, 'Member');
});

// Task 2: ownership, persistence, storage failures, and transient shopping UI.
const secondProduct = "GnC Joro's Classical Guitar";
const thirdProduct = 'GnC Renus E-Guitar';

function assertItems(app, cart, purchased = []) {
    assert.equal(JSON.stringify(app.run('cart')), JSON.stringify(cart));
    assert.equal(JSON.stringify(app.run('earlierPurchases.concat(orders.slice().reverse().flatMap(order => order.items.flatMap(item => Array(item.quantity).fill(item.name))))')), JSON.stringify(purchased));
}

function purchase(app, entry = 'checkoutCart()') {
    app.run(entry); app.fill(); app.run('proceedPurchase()');
}

function assertDetailsCleared(app) {
    for (const id of ['name', 'address', 'cellphone']) assert.equal(app.get(id).value, '', id);
    for (const id of ['receipt-date', 'receipt-order-id']) assert.equal(app.get(id).textContent, '—', id);
    for (const id of ['confirmed-guitar', 'confirmed-address', 'confirmed-cellphone']) assert.equal(app.get(id).textContent, '', id);
    for (const id of ['buy-now-modal', 'confirmation-modal', 'overlay']) assert.equal(app.get(id).style.display, 'none', id);
    assert.equal(app.get('tracking-section').hidden, true);
    assert.equal(app.intervals.size, 0);
    for (const step of app.document.querySelectorAll('.tracker-step')) {
        assert.equal(step.classList.contains('active'), false);
        assert.equal(step.classList.contains('completed'), false);
    }
    for (let i = 0; i < 4; i++) assert.equal(app.get('tracker-time-' + i).textContent, 'Pending');
    for (let i = 0; i < 3; i++) assert.equal(app.get('connector-fill-' + i).style.width, '0%');
    assert.doesNotMatch(app.toasts(), /Test Customer|Demo address|delivered|being prepared|out for delivery|Added to cart/i);
}

test('member A, member B and guest keep independent arrays through switches, reloads and new sessions', async () => {
    const storage = {
        [v1Key('member_a')]: record([product], [thirdProduct]),
        [v1Key('member_b')]: record([secondProduct]),
        [ownerKey(null)]: record([thirdProduct]),
        unrelated_setting: 'keep me'
    };
    const clerk = mockClerk('member_a'), app = boot({ clerk, storage }); await app.settle();
    assertItems(app, [product], [thirdProduct]);
    purchase(app); assertItems(app, [], [thirdProduct, product]);
    clerk.member('member_b'); assertItems(app, [secondProduct]); assertDetailsCleared(app);
    app.run('addToCart(guitarDatabase[0].name)');
    clerk.member('member_a'); assertItems(app, [], [thirdProduct, product]);
    assert.equal(app.intervals.size, 0, 'returning to history never starts tracking');
    const returned = boot({ clerk: mockClerk('member_a'), storage }); await returned.settle();
    assertItems(returned, [], [thirdProduct, product]); assertDetailsCleared(returned);
    const second = boot({ clerk: mockClerk('member_b'), storage }); await second.settle();
    assertItems(second, [secondProduct, product]);
    const guest = boot({ profile: cachedGuest, storage }); await guest.settle();
    assertItems(guest, [thirdProduct]);
    guest.run('addToCart(guitarDatabase[1].name)');
    const guestReload = boot({ storage }); await guestReload.settle();
    assertItems(guestReload, [thirdProduct, secondProduct]);
    assert.equal(storage.unrelated_setting, 'keep me');
});

test('guest cart never merges into a new or returning member, even with a cached guest profile', async () => {
    const storage = { [ownerKey(null)]: record([product]) };
    const clerk = mockClerk(), app = boot({ clerk, storage, profile: cachedGuest }); await app.settle();
    assertItems(app, [product]);
    clerk.member('member_a'); assertItems(app, []);
    assert.equal(app.run('shoppingOwner'), ownerKey('member_a'));
    assert.equal(storage[ownerKey('member_a')], undefined, 'loading an absent owner must not create data');
    app.run('addToCart(guitarDatabase[1].name)');
    const returned = boot({ clerk: mockClerk('member_a'), storage, profile: cachedGuest }); await returned.settle();
    assertItems(returned, [secondProduct]);
    assert.equal(storage[ownerKey(null)], record([product]));
});

test('member storage uses Clerk user ID despite identical email/name or a forged cache', async () => {
    const storage = {
        [v1Key('member_a')]: record([product]), [v1Key('member_b')]: record([secondProduct])
    };
    const clerk = mockClerk('member_b');
    clerk.user.firstName = 'member_a'; clerk.user.primaryEmailAddress.emailAddress = 'member_a@example.test';
    const app = boot({ clerk, storage, profile: JSON.stringify({ id: 'member_a', username: 'member_a', isGuest: false }) });
    await app.settle(); assertItems(app, [secondProduct]); assert.equal(app.run('shoppingOwner'), ownerKey('member_b'));
});

for (const change of ['account switch', 'logout', 'expiration', 'auth error', 'retry initialization']) {
    test('transition clears all prior purchase details and cancels even queued delivery callbacks: ' + change, async () => {
        const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle(); purchase(app);
        const before = app.storage[ownerKey('member_a')];
        const tick = [...app.intervals.values()][0]; assert.equal(tick.ms, 1000);
        app.advance(12000); tick.fn();
        assert.match(app.toasts(), /Simulated.*delivered/);
        const queued = [...app.timers.values()].map(timer => timer.fn);
        let pending;
        if (change === 'account switch') clerk.member('member_b');
        if (change === 'logout') pending = app.run('logoutUser()');
        if (change === 'expiration') { clerk.session.status = 'expired'; clerk.emit(); }
        if (change === 'auth error') { clerk.status = 'error'; clerk.emit(); }
        if (change === 'retry initialization') { clerk.load = () => new Promise(() => {}); pending = app.run('initializeAuthentication()'); }
        assertDetailsCleared(app); assertItems(app, []);
        tick.fn(); queued.forEach(callback => callback()); // Simulate callbacks already queued before cancellation.
        assertDetailsCleared(app);
        assert.equal(app.storage[ownerKey('member_a')], before);
        if (change === 'logout') await pending;
        if (change === 'retry initialization') { app.timeout(); await app.settle(); await pending; }
    });
}

test('new checkout cancels the older purchase tracking callback', async () => {
    const app = boot({ clerk: mockClerk('member_a') }); await app.settle(); purchase(app);
    const oldTick = [...app.intervals.values()][0].fn;
    app.advance(8000); oldTick();
    purchase(app, 'buyNow(guitarDatabase[1].name)');
    oldTick();
    assert.equal(app.run('currentTrackingStep'), 0);
    assert.equal(app.document.querySelectorAll('.tracker-step')[3].classList.contains('completed'), false);
    assert.equal(app.intervals.size, 1);
});

test('tracking detects silent sign-out before showing the next delivery notification', async () => {
    const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle(); purchase(app);
    const tick = [...app.intervals.values()][0].fn;
    clerk.member(null, false); tick(); assertDetailsCleared(app); assertItems(app, []);
});

test('logout immediately hides saved shopping and restores only arrays on failed sign-out', async () => {
    const waiting = deferred(), clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle();
    purchase(app, 'buyNow(guitarDatabase[1].name)');
    const before = app.storedShopping(); clerk.signOut = () => waiting.promise;
    const pending = app.run('logoutUser()');
    assertItems(app, []); assertDetailsCleared(app); assert.equal(app.run('shoppingOwner'), null);
    assertRejected(app, 'addToCart(guitarDatabase[2].name); removeFromCart(0); proceedPurchase()');
    waiting.reject(new Error('offline')); await pending;
    assertItems(app, [product], [secondProduct]); assertDetailsCleared(app);
    assert.equal(app.storedShopping(), before); assert.equal(app.get('auth-message').textContent, 'We couldn’t confirm sign-out. Please try again.');
});

for (const owner of ['member_a', null]) {
    test('unowned legacy keys are untouched and unused for ' + (owner || 'guest'), async () => {
        const storage = { gnc_cart: JSON.stringify([product]), gnc_purchased: '{malformed legacy', unrelated_setting: 'keep' };
        const app = boot({ clerk: mockClerk(owner), profile: owner ? cachedMember : cachedGuest, storage }); await app.settle();
        assertItems(app, []);
        assert.equal(app.get('cart-legacy-notice').hidden, false);
        assert.equal(app.get('purchases-legacy-notice').hidden, false);
        assert.equal(app.get('auth-notice').hidden, true, 'legacy information never keeps the account notice visible');
        app.run('addToCart(guitarDatabase[1].name)');
        if (owner) purchase(app);
        assert.equal(storage.gnc_cart, JSON.stringify([product])); assert.equal(storage.gnc_purchased, '{malformed legacy');
        assert.equal(storage.unrelated_setting, 'keep');
        assert.equal(app.operations.some(op => op.operation !== 'read' && ['gnc_cart', 'gnc_purchased'].includes(op.key)), false);
        assert.equal((owner ? JSON.parse(storage[ownerKey(owner)]).orders : JSON.parse(storage[ownerKey(owner)]).purchasedItems).length, owner ? 1 : 0);
    });
}

for (const malformed of [
    '{bad json', 'null', '[]', '{}', record(null), record([], {}),
    record([null]), record([{ name: product }]), record(['<img src=x onerror=alert(1)>']),
    record([], [null]), JSON.stringify({ version: 2, cart: [], purchasedItems: [] })
]) {
    test('malformed owner data is preserved and mutations pause: ' + malformed, async () => {
        const key = v1Key('member_a'), storage = { [key]: malformed };
        const app = boot({ clerk: mockClerk('member_a'), storage }); await app.settle();
        assert.equal(app.run('authState'), 'member'); assertItems(app, []);
        assert.equal(app.run('shoppingReady'), false); assert.equal(app.get('storage-retry-btn').hidden, false);
        assert.match(app.get('shopping-message').textContent, /saved data is untouched/);
        app.fill(); assertRejected(app, 'addToCart(guitarDatabase[0].name); removeFromCart(0); buyNow(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
        assert.equal(storage[key], malformed);
        storage[key] = record([secondProduct]); app.run('retryShoppingStorage()');
        assertItems(app, [secondProduct]); assert.equal(app.run('shoppingReady'), true);
        assert.equal(app.clerk.listeners.size, 1);
    });
}

test('storage read failure never exposes the prior owner and a retry reloads only the current owner', async () => {
    const clerk = mockClerk('member_a'), faults = {}, storage = {
        [v1Key('member_a')]: record([product]), [v1Key('member_b')]: record([secondProduct], [thirdProduct])
    };
    const app = boot({ clerk, faults, storage }); await app.settle(); purchase(app);
    faults.read = ownerKey('member_b'); clerk.member('member_b');
    assertItems(app, []); assertDetailsCleared(app); assert.equal(app.run('shoppingReady'), false);
    assertRejected(app, 'addToCart(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
    delete faults.read; app.run('retryShoppingStorage()'); assertItems(app, [secondProduct], [thirdProduct]);
    assertDetailsCleared(app);
});

test('all localStorage reads failing cannot crash initialization, theme changes or authentication', async () => {
    const app = boot({ clerk: mockClerk('member_a'), faults: { read: true, write: true, remove: true } }); await app.settle();
    assert.equal(app.run('authState'), 'member'); assertItems(app, []);
    assert.match(app.get('shopping-message').textContent, /could not read/);
    app.run('toggleTheme()'); assert.match(app.toasts(), /could not save the preference/);
    assertRejected(app, 'addToCart(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
});

for (const mode of ['buy now', 'cart']) {
    test('failed checkout write is atomic, keeps cart/details and allows a single successful retry: ' + mode, async () => {
        const key = ownerKey('member_a'), app = boot({ clerk: mockClerk('member_a') }); await app.settle();
        app.run(mode === 'cart' ? 'checkoutCart()' : 'buyNow(guitarDatabase[1].name)'); app.fill();
        app.faults.write = key;
        assertRejected(app, 'proceedPurchase()');
        assert.equal(app.get('confirmation-modal').style.display, 'none'); assert.equal(app.intervals.size, 0);
        assert.equal(app.get('buy-now-modal').style.display, 'block'); assert.equal(app.get('name').value, 'Test Customer');
        assert.match(app.get('shopping-message').textContent, /Nothing was changed or purchased/);
        assert.match(app.toasts(), /could not save/, 'save failure must also be visible above the checkout overlay');
        assert.notEqual(app.run('checkoutIdentity'), null);
        delete app.faults.write; app.run('proceedPurchase()');
        assertItems(app, mode === 'cart' ? [] : [product], [mode === 'cart' ? product : secondProduct]);
        assert.equal(app.get('confirmation-modal').style.display, 'block'); assert.equal(app.intervals.size, 1);
        assert.equal(app.get('shopping-message').hidden, true);
        assertRejected(app, 'proceedPurchase()');
        const writes = app.operations.filter(op => op.operation === 'write' && op.key.startsWith('gnc_shopping_'));
        assert.equal(writes.length, 2, 'one failed write and one successful atomic write');
    });
}

test('failed cart add/remove writes preserve both memory and persisted data', async () => {
    const app = boot({ profile: cachedGuest }); await app.settle(); app.faults.write = ownerKey(null);
    assertRejected(app, 'addToCart(guitarDatabase[1].name); removeFromCart(0)');
    assert.doesNotMatch(app.toasts(), /Added to cart|Removed:/);
    delete app.faults.write; app.run('removeFromCart(0)'); assertItems(app, []);
});

test('direct invalid product/index requests never persist malformed entries', async () => {
    const app = boot({ clerk: mockClerk('member_a') }); await app.settle();
    assertRejected(app, 'addToCart("unknown"); addToCart({}); removeFromCart(-1); removeFromCart(9); removeFromCart("0"); buyNow("unknown"); proceedPurchase()');
});

test('silent account switch rejects a stale cart edit instead of applying it to the next owner', async () => {
    const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle();
    const before = app.storedShopping(); clerk.member('member_b', false);
    app.run('addToCart(guitarDatabase[1].name)');
    assertItems(app, []); assert.equal(app.storedShopping(), before);
    app.run('addToCart(guitarDatabase[1].name)'); assertItems(app, [secondProduct]);
});

test('initialization failure and signed-out states never read member data or allow cart edits', async () => {
    const clerk = mockClerk('member_a'); clerk.load = async () => { throw new Error('offline'); };
    const app = boot({ clerk, profile: cachedMember }); await app.settle();
    assertItems(app, []); assertRejected(app, 'addToCart(guitarDatabase[1].name); removeFromCart(0); applyCoupon()');
    assert.equal(app.operations.some(op => op.operation === 'read' && op.key.startsWith('gnc_shopping_')), false);
    const signedOut = boot({ storage: app.storage, profile: cachedMember }); await signedOut.settle();
    assertItems(signedOut, []); assertRejected(signedOut, 'addToCart(guitarDatabase[1].name); removeFromCart(0)');
    assert.equal(signedOut.operations.some(op => op.operation === 'read' && op.key.startsWith('gnc_shopping_')), false);
});

test('guest logout preserves its saved cart and returning guest access restores it', async () => {
    const app = boot({ profile: cachedGuest }); await app.settle();
    app.run('addToCart(guitarDatabase[1].name)'); const before = app.storedShopping();
    await app.run('logoutUser()'); assertItems(app, []); assertDetailsCleared(app);
    assert.equal(app.storedShopping(), before);
    const returned = boot({ profile: cachedGuest, storage: app.storage }); await returned.settle();
    assertItems(returned, [product, secondProduct]);
    assertRejected(returned, 'checkoutCart(); proceedPurchase()');
});

test('coupon state is cleared with owner changes and a failed save preserves previous purchase history', async () => {
    const key = ownerKey('member_a'), clerk = mockClerk('member_a');
    const app = boot({ clerk, storage: { [v1Key('member_a')]: record([product], [thirdProduct]) } }); await app.settle();
    app.get('coupon-input').value = 'GNC2026'; app.run('applyCoupon()');
    assert.ok(app.run('calculatePurchase(cart, appliedCoupon).discount') > 0);
    app.run('checkoutCart()'); app.fill(); app.faults.write = key;
    assertRejected(app, 'proceedPurchase()'); assertItems(app, [product], [thirdProduct]);
    clerk.member('member_b');
    assert.equal(app.run('calculatePurchase(cart, appliedCoupon).discount'), 0); assert.equal(app.run('appliedCoupon'), '');
    assert.equal(app.get('coupon-input').value, ''); assert.equal(app.get('coupon-status').innerHTML, '');
    assert.equal(app.get('shopping-message').hidden, true);
});

// Focused UX regressions; ownership and checkout assertions above remain in place.
test('legacy dismissal persists across rerenders, panel reopening, identity changes and reloads', async () => {
    const storage = { gnc_cart: '["old"]', gnc_purchased: '{old}', unrelated: 'keep' };
    const app = boot({ clerk: mockClerk('member_a'), storage }); await app.settle();
    assert.equal(app.get('cart-legacy-notice').hidden, false);
    const before = app.storedShopping(); app.run('dismissLegacyShopping()');
    assert.equal(storage[legacyAckKey], 'dismissed'); assert.equal(app.storedShopping(), before);
    app.run('checkLegacyShopping(); renderAuthUI(); updateCart(); updatePurchasedItems(); togglePanel("cart-panel")');
    app.clerk.member('member_b');
    for (const id of ['cart-legacy-notice', 'purchases-legacy-notice']) assert.equal(app.get(id).hidden, true);
    const reload = boot({ profile: cachedGuest, storage }); await reload.settle();
    assert.equal(reload.get('cart-legacy-notice').hidden, true); assert.equal(reload.get('purchases-legacy-notice').hidden, true);
    assert.equal(storage.gnc_cart, '["old"]'); assert.equal(storage.gnc_purchased, '{old}'); assert.equal(storage.unrelated, 'keep');
});

test('legacy dismissal falls back to memory when acknowledgement writes and later reads fail', async () => {
    const storage = { gnc_cart: '[]' }, faults = { write: legacyAckKey, read: legacyAckKey };
    const app = boot({ profile: cachedGuest, storage, faults }); await app.settle();
    assert.equal(app.get('cart-legacy-notice').hidden, false);
    app.run('dismissLegacyShopping()'); faults.read = true;
    app.run('checkLegacyShopping(); renderAuthUI(); togglePanel("purchased-panel")');
    assert.equal(app.get('cart-legacy-notice').hidden, true); assert.equal(app.get('purchases-legacy-notice').hidden, true);
    assert.equal(storage[legacyAckKey], undefined); assert.equal(storage.gnc_cart, '[]');
    assert.equal(app.run('authState'), 'guest');
});

test('unavailable legacy storage does not invent a legacy notice or crash rendering', async () => {
    const app = boot({ clerk: mockClerk('member_a'), faults: { read: true } }); await app.settle();
    assert.equal(app.get('cart-legacy-notice').hidden, true);
    assert.equal(app.get('auth-notice').hidden, false);
    assert.equal(app.get('cart-state-title').textContent, 'Shopping unavailable');
    assertRejected(app, 'addToCart(guitarDatabase[0].name); proceedPurchase()');
});

for (const failure of ['initializing', 'authentication', 'storage read', 'storage write', 'logout']) {
    test('legacy dismissal cannot hide actionable feedback or change authorization: ' + failure, async () => {
        const clerk = mockClerk('member_a'), faults = {}, storage = { gnc_cart: '[]', [v1Key('member_a')]: record([product]) };
        if (failure === 'initializing') clerk.load = () => new Promise(() => {});
        if (failure === 'authentication') clerk.load = async () => { throw new Error('offline'); };
        if (failure === 'storage read') faults.read = ownerKey('member_a');
        const app = boot({ clerk, storage, faults }); await app.settle();
        if (failure === 'storage write') { faults.write = ownerKey('member_a'); app.run('addToCart(guitarDatabase[1].name)'); }
        if (failure === 'logout') { clerk.signOut = async () => { throw new Error('offline'); }; await app.run('logoutUser()'); }
        const before = { shopping: app.shopping(), state: app.run('authState'), message: app.get('auth-message').textContent, storage: app.get('shopping-message').textContent, blocked: app.get('purchase-submit').disabled, retry: app.get('auth-retry-btn').onclick };
        app.run('dismissLegacyShopping(); renderAuthUI(); checkLegacyShopping()');
        assert.equal(app.get('cart-legacy-notice').hidden, true); assert.equal(app.get('auth-notice').hidden, false);
        assert.equal(app.shopping(), before.shopping); assert.equal(app.run('authState'), before.state);
        assert.equal(app.get('auth-message').textContent, before.message); assert.equal(app.get('shopping-message').textContent, before.storage);
        assert.equal(app.get('purchase-submit').disabled, before.blocked); assert.equal(app.get('auth-retry-btn').onclick, before.retry);
        assertRejected(app, 'proceedPurchase()');
        if (failure === 'storage read') assert.equal(app.get('storage-retry-btn').hidden, false);
    });
}

test('profile menu exposes guest Sign In and member Log Out with no placeholder account actions', async () => {
    const clerk = mockClerk(), app = boot({ clerk, profile: cachedGuest }); await app.settle();
    assert.equal(app.get('dropdown-role').textContent, 'Browsing as guest');
    assert.equal(app.get('profile-sign-in').hidden, false); assert.equal(app.get('profile-sign-in').getAttribute('href'), 'login.html');
    assert.equal(app.get('profile-logout').hidden, true);
    assert.doesNotMatch(html, /My Account|Settings – coming soon/);
    clerk.member('member_a');
    assert.equal(app.get('profile-sign-in').hidden, true); assert.equal(app.get('profile-logout').hidden, false);
    assert.equal(app.get('logout-label').textContent, 'Log Out'); assert.equal(app.get('profile-logout').disabled, false);
});

test('pending logout is concise, disables repeat clicks, and failed logout has a working retry', async () => {
    const clerk = mockClerk('member_a'), waiting = deferred(), app = boot({ clerk }); await app.settle();
    let calls = 0; clerk.signOut = () => { calls++; return waiting.promise; };
    const pending = app.run('logoutUser()'); await app.run('logoutUser()');
    assert.equal(calls, 1); assert.equal(app.get('profile-logout').disabled, true);
    assert.equal(app.get('logout-label').textContent, 'Signing out…'); assert.equal(app.get('auth-message').textContent, 'Signing out…');
    assert.doesNotMatch(app.toasts(), /Logged out successfully/);
    waiting.reject(new Error('offline')); await pending;
    assert.equal(app.get('profile-logout').disabled, false); assert.equal(app.get('auth-retry-btn').textContent, 'Retry sign-out');
    assert.equal(app.get('auth-message').textContent, 'We couldn’t confirm sign-out. Please try again.');
    assert.equal(app.get('profile-error').hidden, false); assert.equal(app.get('profile-error').textContent, app.get('auth-message').textContent);
    assert.equal(app.get('profile-retry').hidden, false); assert.equal(app.get('profile-retry').textContent, 'Retry sign-out');
    app.run('dismissLegacyShopping()'); assert.equal(app.get('profile-error').hidden, false);
    clerk.signOut = async () => clerk.member(null);
    await app.get('profile-retry').onclick(); assert.equal(app.location.href, 'login.html');
    assert.equal(app.get('profile-error').hidden, true); assert.equal(app.get('profile-retry').hidden, true);
    assert.doesNotMatch(app.get('auth-message').textContent, /couldn’t confirm/);
});

test('failed logout with lost Clerk verification offers verification retry before another sign-out', async () => {
    const clerk = mockClerk('member_a'), app = boot({ clerk }); await app.settle();
    clerk.signOut = async () => { clerk.loaded = false; throw new Error('offline'); };
    await app.run('logoutUser()');
    assert.equal(app.run('authState'), 'error'); assert.equal(app.get('auth-retry-btn').textContent, 'Retry verification');
    assert.equal(app.get('profile-retry').textContent, 'Retry verification');
    assert.equal(app.get('auth-message').textContent, 'We couldn’t confirm sign-out. Please try again.');
    assertRejected(app, 'addToCart(guitarDatabase[0].name); proceedPurchase()');
    app.get('auth-retry-btn').onclick(); await app.settle();
    assert.equal(app.run('authState'), 'member'); assert.equal(app.get('auth-notice').hidden, true);
});

test('resolved member empty states become populated and return to empty without altering history', async () => {
    const app = boot({ clerk: mockClerk('member_a'), cart: [] }); await app.settle();
    assert.equal(app.get('cart-empty-state').hidden, false); assert.equal(app.get('cart-state-title').textContent, 'Your cart is empty');
    assert.equal(app.get('order-empty-state').hidden, false); assert.equal(app.get('purchases-state-title').textContent, 'No purchases yet');
    assert.equal(app.get('purchases-state-action').textContent, 'Browse Guitars');
    app.run('addToCart(guitarDatabase[0].name)'); assert.equal(app.get('cart-empty-state').hidden, true);
    purchase(app); assert.equal(app.get('cart-empty-state').hidden, false); assert.equal(app.get('order-empty-state').hidden, true);
    assert.equal(app.get('order-receipt').style.display, 'block'); assertItems(app, [], [product]);
});

test('guest purchases explain sign-in and guest cart still supports empty and nonempty states', async () => {
    const app = boot({ profile: cachedGuest, cart: [] }); await app.settle();
    assert.equal(app.get('cart-state-title').textContent, 'Your cart is empty');
    assert.equal(app.get('purchases-state-title').textContent, 'Sign in to view purchases');
    assert.equal(app.get('purchases-state-action').textContent, 'Sign In');
    app.run('addToCart(guitarDatabase[0].name)'); assert.equal(app.get('cart-empty-state').hidden, true);
    assertRejected(app, 'checkoutCart(); proceedPurchase()');
    app.get('purchases-state-action').onclick(); assert.equal(app.location.href, 'login.html');
});

test('checking and failed account states show feedback instead of false empty claims, and retry resolves it', async () => {
    const clerk = mockClerk('member_a'), waiting = deferred(); clerk.load = () => waiting.promise;
    const app = boot({ clerk, cart: [] });
    assert.equal(app.get('cart-state-title').textContent, 'Checking your account…');
    assert.equal(app.get('purchases-state-title').textContent, 'Checking your account…');
    waiting.reject(new Error('offline')); await app.settle();
    assert.equal(app.get('cart-state-title').textContent, 'Account unavailable'); assert.equal(app.get('purchases-state-title').textContent, 'Account unavailable');
    clerk.load = async () => { clerk.loaded = true; };
    app.get('cart-state-action').onclick(); await app.settle();
    assert.equal(app.get('auth-notice').hidden, true); assert.equal(app.get('cart-state-title').textContent, 'Your cart is empty');
    assert.equal(app.get('purchases-state-title').textContent, 'No purchases yet'); assert.equal(clerk.listeners.size, 1);
});

test('storage read and write errors remain truthful in empty and populated panels and clear after recovery', async () => {
    const key = ownerKey('member_a'), faults = { read: key }, app = boot({ clerk: mockClerk('member_a'), cart: [], faults }); await app.settle();
    assert.equal(app.get('cart-state-title').textContent, 'Shopping unavailable');
    assert.equal(app.get('purchases-state-title').textContent, 'Shopping unavailable');
    assert.equal(app.get('cart-state-action').textContent, 'Retry storage');
    delete faults.read; app.get('cart-state-action').onclick();
    assert.equal(app.get('auth-notice').hidden, true);
    faults.write = key; app.run('addToCart(guitarDatabase[0].name)');
    assert.equal(app.get('cart-state-title').textContent, 'Changes weren’t saved'); assert.equal(app.get('cart-state-action').hidden, true);
    delete faults.write; app.run('addToCart(guitarDatabase[0].name)');
    assert.equal(app.get('auth-notice').hidden, true); assert.equal(app.get('cart-empty-state').hidden, true);
    faults.write = key; app.run('removeFromCart(0)');
    assert.equal(app.get('cart-panel-error').hidden, false); assert.equal(app.get('cart-empty-state').hidden, true); assertItems(app, [product]);
});

test('browse action closes panels, scrolls and focuses the collection; Escape closes panels/profile', async () => {
    const app = boot({ profile: cachedGuest, cart: [] }); await app.settle();
    app.run('togglePanel("cart-panel")'); assert.equal(app.get('cart-panel').inert, false);
    assert.equal(app.document.activeElement.id, 'cart-panel-close');
    app.get('cart-state-action').onclick();
    assert.equal(app.get('cart-panel').inert, true); assert.equal(app.get('overlay').style.display, 'none');
    assert.equal(app.document.activeElement.id, 'collection-section'); assert.equal(app.get('collection-section').lastScroll.behavior, 'smooth');
    app.run('togglePanel("purchased-panel")'); app.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(app.get('purchased-panel').inert, true); assert.equal(app.document.activeElement.id, 'purchases-toggle');
    app.run('toggleProfileDropdown()'); assert.equal(app.get('profile-toggle').getAttribute('aria-expanded'), 'true');
    app.document.dispatch('keydown', { key: 'Escape' }); assert.equal(app.get('profile-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(app.document.activeElement.id, 'profile-toggle');
});

test('every product card uses consistent actions while preserving guarded handlers', async () => {
    const app = boot({ profile: cachedGuest }); await app.settle();
    const cards = app.get('guitar-grid').innerHTML;
    assert.equal((cards.match(/>View Details<\/button>/g) || []).length, 12);
    assert.doesNotMatch(cards, /buyNow\(/);
    assert.equal((cards.match(/Add to Cart\s*<\/button>/g) || []).length, 12);
    assert.equal((cards.match(/openQuickView\('/g) || []).length, 12);
    assert.equal((cards.match(/addToCart\('/g) || []).length, 12);
    assertRejected(app, 'buyNow(guitarDatabase[0].name); proceedPurchase()');
});

test('Quick View clears unavailable details and keeps price guards through account refreshes', async () => {
    const app = boot({ profile: cachedGuest });
    await app.settle();
    app.run("const guitar = guitarDatabase[0]; guitar.image = ''; renderQuickView(guitar.name)");
    assert.equal(app.get('detail-photo').textContent, 'No photo available');
    assert.equal(app.get('detail-add').disabled, false);

    app.run("guitar.description = ' '; guitar.category = ''; guitar.price = ''; renderQuickView(guitar.name); renderAuthUI()");
    assert.equal(app.get('detail-description').textContent, 'No description available yet.');
    assert.equal(app.get('detail-category').hidden, true);
    assert.equal(app.get('detail-price').textContent, 'Price unavailable');
    assert.equal(app.get('detail-price-note').hidden, false);
    assert.equal(app.get('detail-add').disabled, true);
    assert.equal(app.get('detail-buy').disabled, true);

    app.run("renderQuickView('Removed guitar')");
    assert.equal(app.get('detail-name').textContent, 'This guitar is no longer available.');
    assert.equal(app.get('detail-price').textContent, '');
    assert.equal(app.get('detail-photo').hidden, true);
    assert.equal(app.get('detail-actions').hidden, true);
    assert.equal(app.run('detailName'), null);
});

test('separate immutable receipts survive refresh with quantities, coupon rounding and earlier purchases', async () => {
    const key = ownerKey('member_a');
    const storage = { [v1Key('member_a')]: record([product, product], ['Discontinued guitar']) };
    const app = boot({ clerk: mockClerk('member_a'), storage }); await app.settle();
    assert.equal(app.get('earlier-items').children[0].textContent, 'Discontinued guitar');
    app.run("guitarDatabase[0].price = '₱100.03'");
    app.get('coupon-input').value = 'GNC2026'; app.run('applyCoupon()');
    purchase(app, 'buyNow(guitarDatabase[1].name)');
    assert.match(app.get('checkout-amount').textContent, /₱7,990.00/);
    assert.deepEqual(JSON.parse(storage[key]).cart, [product, product]);
    app.run('closeConfirmation(); checkoutCart()');
    assert.match(app.get('checkout-amount').textContent, /₱180.05/);
    app.fill(); app.run('proceedPurchase()');
    assert.doesNotMatch(storage[key], /Test Customer|Demo address|09123456789/);
    const { version, orders: [cartOrder, buyOrder], earlierPurchases } = JSON.parse(storage[key]);
    assert.equal(version, 2); assert.notEqual(cartOrder.id, buyOrder.id);
    assert.deepEqual(earlierPurchases, ['Discontinued guitar']);
    assert.deepEqual(cartOrder.items, [{ name: product, quantity: 2, unitPrice: 10003 }]);
    assert.deepEqual([cartOrder.subtotal, cartOrder.discount, cartOrder.total], [20006, 2001, 18005]);
    assert.deepEqual([buyOrder.subtotal, buyOrder.discount, buyOrder.total], [799000, 0, 799000]);

    const reload = boot({ clerk: mockClerk('member_a'), storage }); await reload.settle();
    reload.advance(8500);
    reload.run('togglePanel("purchased-panel")');
    const [latest, first] = reload.get('order-history').children;
    latest.onclick();
    assert.equal(reload.get('receipt-order-id').textContent, cartOrder.id);
    assert.equal(reload.get('receipt-total').textContent, '₱180.05');
    assert.equal(reload.get('purchased-items').children[0].textContent, product + ' · 2 × ₱100.03');
    assert.equal(reload.run('currentTrackingStep'), 2);
    const queued = [...reload.intervals.values()][0].fn;
    reload.run('togglePanel("purchased-panel")');
    assert.equal(reload.intervals.size, 0);
    reload.advance(4000); queued();
    assert.equal(reload.run('currentTrackingStep'), 2);
    reload.run('togglePanel("purchased-panel")');
    reload.get('order-history').children[1].onclick();
    assert.equal(reload.get('receipt-order-id').textContent, buyOrder.id);
    assert.equal(reload.get('receipt-total').textContent, '₱7,990.00');
    assert.equal(reload.run('currentTrackingStep'), 3);
    assert.equal(reload.intervals.size, 0);
    assert.doesNotMatch(reload.toasts(), /deliver/i);
    reload.clerk.member('member_b'); first.onclick();
    assert.equal(reload.get('order-history').children.length, 0);
    assert.equal(reload.get('order-receipt').style.display, 'none');
});

test('a stale checkout cannot overwrite another tab’s completed order', async () => {
    const key = ownerKey('member_a'), storage = { [v1Key('member_a')]: record([product]) };
    const first = boot({ clerk: mockClerk('member_a'), storage });
    const second = boot({ clerk: mockClerk('member_a'), storage });
    await Promise.all([first.settle(), second.settle()]);
    first.run('checkoutCart()'); first.fill();
    purchase(second, 'buyNow(guitarDatabase[1].name)');
    const saved = storage[key]; first.run('proceedPurchase()');
    assert.equal(storage[key], saved);
    assert.match(first.toasts(), /another tab/);
    purchase(first); assert.equal(JSON.parse(storage[key]).orders.length, 2);
});

test('a historical receipt can reach Delivered while open without a notification', async () => {
    const app = boot({ clerk: mockClerk('member_a') }); await app.settle();
    purchase(app); app.run('closeConfirmation(); togglePanel("purchased-panel")');
    app.get('order-history').children[0].onclick();
    app.advance(12000); [...app.intervals.values()][0].fn();
    assert.equal(app.run('currentTrackingStep'), 3);
    assert.equal(app.intervals.size, 0);
    assert.doesNotMatch(app.toasts(), /deliver/i);
});

test('failed discounted checkout preserves a previous order and retries at the displayed total', async () => {
    const key = ownerKey('member_a'), app = boot({ clerk: mockClerk('member_a') });
    await app.settle();
    purchase(app, 'buyNow(guitarDatabase[1].name)'); app.run('closeConfirmation()');
    app.get('coupon-input').value = 'GNC2026'; app.run('applyCoupon(); checkoutCart()'); app.fill();
    const before = app.storage[key];
    app.faults.write = key; app.run('proceedPurchase()');
    assert.equal(app.storage[key], before);
    assert.equal(app.get('confirmation-modal').style.display, 'none');
    assert.equal(app.get('name').value, 'Test Customer');
    assert.match(app.get('checkout-amount').textContent, /₱3,599\.10/);
    delete app.faults.write; app.run('proceedPurchase()');
    const saved = JSON.parse(app.storage[key]);
    assert.deepEqual(saved.cart, []);
    assert.equal(saved.orders.length, 2);
    assert.deepEqual(saved.orders[1], JSON.parse(before).orders[0]);
    assert.equal(saved.orders[0].total, 359910);
});

test('first successful checkout migrates only the verified member and stays authoritative across two reloads', async () => {
    const id = 'member/a', oldKey = v1Key(id), key = ownerKey(id);
    const cart = [product, secondProduct, product], earlier = ['Retired model', 'Retired model'];
    const original = record(cart, earlier);
    const storage = { [oldKey]: original, [v1Key('member_b')]: record([thirdProduct]), [v1Key(null)]: record([secondProduct]) };
    const app = boot({ clerk: mockClerk(id), storage }); await app.settle();
    const ownerOps = page => page.operations.filter(op => op.key.startsWith('gnc_shopping_'));
    assert.deepEqual(ownerOps(app), [{ operation: 'read', key }, { operation: 'read', key: oldKey }]);
    assertItems(app, cart, earlier);
    assert.equal(app.run('orders.length'), 0);
    app.faults.write = key;
    purchase(app);
    assert.equal(storage[key], undefined);
    assert.equal(storage[oldKey], original);
    assert.equal(app.get('buy-now-modal').style.display, 'block');
    assert.equal(app.get('confirmation-modal').style.display, 'none');
    assert.equal(app.intervals.size, 0);
    assertItems(app, cart, earlier);
    delete app.faults.write;
    app.run('proceedPurchase()');
    const saved = JSON.parse(storage[key]);
    assert.deepEqual(saved.cart, []);
    assert.deepEqual(saved.earlierPurchases, earlier);
    assert.equal(saved.orders.length, 1);
    assert.deepEqual(saved.orders[0].items.map(({ name, quantity }) => [name, quantity]), [[product, 2], [secondProduct, 1]]);
    assert.deepEqual(ownerOps(app).filter(op => op.operation === 'write').map(op => op.key), [key, key]);
    for (let i = 0; i < 2; i++) {
        const reload = boot({ clerk: mockClerk(id), storage }); await reload.settle();
        reload.run('togglePanel("purchased-panel")');
        assert.deepEqual(ownerOps(reload), [{ operation: 'read', key }]);
        assert.equal(reload.get('order-history').children.length, 1);
        assert.deepEqual(reload.get('earlier-items').children.map(li => li.textContent), earlier);
        reload.get('order-history').children[0].onclick();
        assert.equal(reload.get('receipt-order-id').textContent, saved.orders[0].id);
        assert.equal(reload.run('cart.length'), 0);
    }
    app.clerk.member('member_b');
    assertItems(app, [thirdProduct]); assertDetailsCleared(app);
    assert.equal(storage[ownerKey('member_b')], undefined);
    const guest = boot({ storage, profile: cachedGuest }); await guest.settle();
    guest.run('addToCart(guitarDatabase[0].name)');
    assertItems(guest, [secondProduct, product]);
    assert.ok(ownerOps(guest).every(op => op.key === v1Key(null)));
    assert.equal(storage[oldKey], original);
    assert.deepEqual(JSON.parse(storage[key]), saved);
});

test('cart edits carry forward receipts previously saved under a member’s v1 key', async () => {
    const oldKey = v1Key('member_a'), key = ownerKey('member_a');
    const order = {
        id: '#GNC-previous', createdAt: 1750000000000,
        items: [{ name: 'Retired guitar', quantity: 1, unitPrice: 99900 }],
        subtotal: 99900, discount: 0, total: 99900
    };
    const original = JSON.stringify({ version: 2, cart: [product], earlierPurchases: [], orders: [order] });
    const storage = { [oldKey]: original };
    const app = boot({ clerk: mockClerk('member_a'), storage }); await app.settle();
    assert.equal(storage[key], undefined);
    app.run('removeFromCart(0)');
    assert.deepEqual(JSON.parse(storage[key]), { version: 2, cart: [], earlierPurchases: [], orders: [order] });
    assert.equal(storage[oldKey], original);
});

for (const failure of ['malformed v2', 'v1 shape under v2', 'unreadable v2', 'unreadable v1']) {
    test(failure + ' blocks changes until storage retry', async () => {
        const key = ownerKey('member_a'), oldKey = v1Key('member_a');
        const storage = { [oldKey]: record([product], [thirdProduct]) }, faults = {};
        if (failure === 'malformed v2') storage[key] = JSON.stringify({ version: 2, cart: [], earlierPurchases: [], orders: [{}] });
        if (failure === 'v1 shape under v2') storage[key] = record([]);
        if (failure.startsWith('unreadable')) faults.read = failure === 'unreadable v2' ? key : oldKey;
        const app = boot({ clerk: mockClerk('member_a'), storage, faults }); await app.settle();
        assert.equal(app.get('storage-retry-btn').hidden, false);
        assertRejected(app, 'addToCart(guitarDatabase[0].name); checkoutCart(); proceedPurchase()');
        assertItems(app, []);
        if (failure !== 'unreadable v1') assert.equal(app.operations.some(op => op.key === oldKey), false);
        storage[key] = JSON.stringify({ version: 2, cart: [], earlierPurchases: [], orders: [] });
        delete faults.read;
        app.operations.length = 0;
        app.run('retryShoppingStorage(); addToCart(guitarDatabase[1].name)');
        assertItems(app, [secondProduct]);
        assert.equal(app.operations.some(op => op.key === oldKey), false);
        assert.equal(storage[oldKey], record([product], [thirdProduct]));
    });
}

test('grouped cart controls keep the unit badge, line price, focus and saved quantities in sync', async () => {
    const app = boot({ clerk: mockClerk('member_a'), cart: [product, secondProduct, product] }); await app.settle();
    const rows = app.get('cart-items');
    const rowText = node => node.textContent + ' ' + node.children.map(rowText).join(' ');
    assert.equal(rows.children.length, 2);
    assert.match(rowText(rows.children[0]), /Qty 2.*Line total ₱7,998\.00/);
    app.get('cart-product-0-plus').onclick();
    assertItems(app, [product, secondProduct, product, product]);
    assert.equal(app.get('cart-count').textContent, '4');
    assert.equal(app.document.activeElement.id, 'cart-product-0-plus');
    app.get('cart-product-0-minus').onclick();
    assertItems(app, [product, secondProduct, product]);
    app.faults.write = ownerKey('member_a');
    for (const action of ['minus', 'plus', 'remove']) {
        const previous = app.storedShopping();
        app.get('cart-product-0-' + action).onclick();
        assert.equal(app.storedShopping(), previous);
        assert.equal(app.get('cart-count').textContent, '3');
        assert.match(rowText(rows.children[0]), /Qty 2.*Line total ₱7,998\.00/);
        assert.equal(app.get('cart-panel-error').hidden, false);
    }
    delete app.faults.write;
    app.get('cart-product-0-remove').onclick();
    assertItems(app, [secondProduct]);
    app.get('cart-product-1-minus').onclick();
    assertItems(app, []);
    assert.equal(app.get('cart-footer').hidden, true);
    assert.equal(app.document.activeElement.id, 'cart-state-action');
});

test('checkout review, field errors, save retry and receipt all use the displayed order', async () => {
    const app = boot({ clerk: mockClerk('member_a'), cart: [product, product] }); await app.settle();
    app.get('coupon-input').value = 'GNC2026'; app.run('applyCoupon(); checkoutCart(); proceedPurchase()');
    assert.equal(app.get('checkout-items').children[0].textContent, product + ' · 2 × ₱3,999.00');
    assert.equal(app.get('checkout-subtotal').textContent, '₱7,998.00');
    assert.equal(app.get('checkout-discount').textContent, '−₱799.80');
    assert.equal(app.get('checkout-amount').textContent, app.get('cart-total').textContent);
    assert.equal(app.document.activeElement.id, 'name');
    for (const id of ['name', 'address', 'cellphone']) {
        assert.equal(app.get(id + '-error').hidden, false);
        assert.equal(app.get(id).getAttribute('aria-invalid'), 'true');
    }
    app.fill(); app.get('cellphone').value = '09abcdefghi';
    app.run('proceedPurchase()');
    assert.equal(app.document.activeElement.id, 'cellphone');
    assert.equal(app.get('name-error').hidden, true);
    assert.equal(app.get('address').value, 'Demo address');
    app.fill(); app.faults.write = ownerKey('member_a'); app.run('proceedPurchase()');
    assert.equal(app.get('checkout-error').hidden, false);
    assert.equal(app.get('purchase-submit').disabled, false);
    delete app.faults.write; app.run('proceedPurchase(); proceedPurchase()');
    assert.equal(app.run('orders.length'), 1);
    assert.equal(app.get('receipt-total').textContent, '₱7,198.20');
});

test('changing member clears checkout review and rejects buttons from the prior cart', async () => {
    const app = boot({ clerk: mockClerk('member_a') }); await app.settle();
    const stale = app.get('cart-product-0-plus');
    app.get('coupon-input').value = 'GNC2026';
    app.run('applyCoupon(); buyNow(guitarDatabase[1].name)');
    assert.equal(app.get('checkout-discount-row').hidden, true);
    assert.equal(app.get('checkout-amount').textContent, '₱7,990.00');
    app.clerk.member('member_b');
    assert.equal(app.get('checkout-items').children.length, 0);
    assert.equal(app.get('checkout-subtotal').textContent, '');
    assert.equal(app.get('buy-now-modal').style.display, 'none');
    app.run('addToCart(guitarDatabase[0].name)'); stale.onclick();
    assertItems(app, [product]);
});

test('checkout reports all blank or over-limit fields beside their controls without changing the cart', async () => {
    const app = boot({ clerk: mockClerk('member_a') }); await app.settle();
    app.run('checkoutCart()');
    const cases = [
        ['   ', ' \n  ', '  ', 'Enter your full name.', 'Enter your delivery address.', 'Enter your mobile number.'],
        ['a'.repeat(101), 'b'.repeat(251), '09abcdefghi', 'Full name must be 100 characters or fewer.',
            'Delivery address must be 250 characters or fewer.', 'Enter an 11-digit mobile number starting with 09.']
    ];
    for (const [name, address, cellphone, ...messages] of cases) {
        const values = { name, address, cellphone };
        for (const [id, value] of Object.entries(values)) app.get(id).value = value;
        assertRejected(app, 'proceedPurchase()');
        assert.equal(app.document.activeElement.id, 'name');
        for (const [index, id] of Object.keys(values).entries()) {
            assert.equal(app.get(id).value, values[id]);
            assert.equal(app.get(id).getAttribute('aria-invalid'), 'true');
            assert.ok(app.get(id).getAttribute('aria-describedby').split(' ').includes(id + '-error'));
            assert.equal(app.get(id + '-error').textContent, messages[index]);
            assert.equal(app.get(id + '-error').hidden, false);
        }
        assert.equal(app.get('confirmation-modal').style.display, 'none');
        assertItems(app, [product]);
    }
    app.get('name').value = 'Ana María O’Neill';
    assertRejected(app, 'proceedPurchase()'); assert.equal(app.document.activeElement.id, 'address');
});

test('mobile validation rejects wrong lengths, prefixes, letters, internal spaces and dashes', async () => {
    const app = boot({ clerk: mockClerk('member_a') }); await app.settle();
    app.run('checkoutCart()'); app.fill();
    for (const number of ['0912345678', '091234567890', '08123456789', '+639123456789', '09123a56789', '09123 456789', '09123-456789']) {
        app.get('cellphone').value = number;
        assertRejected(app, 'proceedPurchase()');
        assert.equal(app.get('cellphone-error').textContent, 'Enter an 11-digit mobile number starting with 09.');
        assert.equal(app.get('cellphone').value, number);
        assert.equal(app.document.activeElement.id, 'cellphone');
        assertItems(app, [product]);
    }
});

test('trimmed checkout accepts Unicode and boundary lengths, preserves multiline addresses and retries privately', async () => {
    for (const name of ['Ana María O’Neill', 'Ñ', 'Jose\u0301-Luis D\'Angelo Jr.', 'n\u0303'.repeat(100)]) {
        const app = boot({ clerk: mockClerk('member_a') }); await app.settle(); app.run('checkoutCart()');
        const address = 'Unit 3\nBarangay Uno\nQuezon City'.padEnd(250, 'a');
        const values = { name: '  ' + name + ' ', address: ' \n' + address + '\n ', cellphone: ' 09123456789 ' };
        for (const [id, value] of Object.entries(values)) app.get(id).value = value;
        app.faults.write = ownerKey('member_a'); assertRejected(app, 'proceedPurchase()');
        for (const [id, value] of Object.entries(values)) assert.equal(app.get(id).value, value);
        assert.equal(app.get('checkout-error').hidden, false);
        delete app.faults.write; app.run('proceedPurchase()');
        assert.equal(app.get('confirmed-address').textContent, address);
        assert.equal(app.get('confirmed-cellphone').textContent, '09123456789');
        const saved = app.storage[ownerKey('member_a')];
        assert.equal(JSON.parse(saved).orders.length, 1);
        for (const privateText of [name, 'Barangay Uno', '09123456789']) assert.equal(saved.includes(privateText), false);
    }
});
