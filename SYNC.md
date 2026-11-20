# Sync between phones: setup

Household Hub can keep both phones in step through a free Supabase project. Until it is set up, the app works as before, on each phone separately.

These steps are for the owner. They involve creating an account, so they are done by hand, once, in about 15 minutes.

## 1. Create the project

1. Go to [supabase.com](https://supabase.com), sign up, and choose **New project**.
2. **Name:** `household-hub`. **Region:** the one nearest you, for example East US.
3. **Database password:** let Supabase generate one and save it in your password manager. The app never uses it.

## 2. Run the setup script

1. Open **SQL Editor**, then **New query**.
2. Paste the whole of [`supabase/setup.sql`](supabase/setup.sql) and choose **Run**. It should finish with "Success. No rows returned".

The script creates the household tables and the rules: only the two members can read the household, each person signs and approves only for themselves, and signatures cannot be removed. It is safe to run again after an update.

## 3. Let sign-in emails carry a code

Phones that have the app on the home screen can't follow an email link back into the app, so sign-in uses a 6-digit code.

1. Open **Authentication**, then **Emails** (also called Email Templates).
2. In both the **Magic Link** template and the **Confirm signup** template, add this line to the message body:

   ```
   Your Household Hub code: {{ .Token }}
   ```
3. Save each template.

## 4. Set the app address

Open **Authentication**, then **URL Configuration**:

- **Site URL:** `https://yomiogbalaja.github.io/household-hub/`
- **Redirect URLs:** add the same address.

## 5. Send the two connection details

Open **Project Settings**, then **API** (or **API Keys**), and copy:

- the **Project URL**, which looks like `https://abcdefgh.supabase.co`
- the **publishable key**, which may be labelled **anon public**

Both are designed to sit in the app's public code; the rules from step 2 decide who can read and write. Send them over, and they go into `config.js` and live on the site.

**Never share the service role key or the database password.** They stay in Supabase.

## 6. Join on both phones

1. **First phone:** pick the one that has your current data. Open the app, go to **Settings & data**, then **Sync between phones**. Enter your email, then the code you're sent. Tap **Start it as** your name. This phone's data becomes the household's.
2. **Invite:** on the same card, enter your partner's email and tap **Invite**.
3. **Second phone:** your partner opens the app and goes to the same card, then signs in with that exact email. They join automatically. If the phone had data of its own, it asks before replacing it with the household copy, and keeps a backup it can restore.

## How it behaves

- **Saving and syncing:** each phone keeps a full copy and works offline. Changes send as soon as there is a connection, and the other phone shows them within a few seconds.
- **Two edits at once:** edits to different items merge. If both of you edit the same item, the later edit wins.
- **Signatures:** a change of responsibility binds only when both of you have signed it, each on your own sign-in. Each signature records the account that made it.
- **The first upload:** the first phone brings in its existing history and signatures as they are. This is allowed only while that person is the only member, and only within an hour of starting.
- **Erase data on this device:** while syncing, this removes the household from that phone only. The shared copy stays.
- **Import:** importing a workbook while syncing replaces the household data for both of you. Signed agreement history is always kept.
- **Sign-in emails:** Supabase's built-in email sender allows only a few sign-in emails per hour. That's fine for two people. If you hit the limit, wait an hour. We can add a dedicated email service later, along with automatic reminder emails.
