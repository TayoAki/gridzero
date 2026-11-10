// Beta terms and privacy notice. DRAFT: written to match how GridZero handles data
// today, for review by a lawyer before launch. Bracketed items need filling in.

import { Link } from "react-router";

const OPERATOR = "[Company legal name]";
const CONTACT = "[contact email]";
const UPDATED = "[date]";

function Terms() {
  return (
    <>
      <h1>Beta terms of use</h1>
      <p className="legal-meta">Last updated {UPDATED}</p>
      <h2>The beta</h2>
      <p>
        GridZero is run by {OPERATOR}. It is in beta: features change, things break, and the service can be paused or
        ended. It is provided as is, without warranties or a guaranteed level of service. Keep your own copy of anything
        you cannot afford to lose; you can download any sheet as CSV from the File menu.
      </p>
      <h2>Your data</h2>
      <p>
        Your workbooks, files and query results stay yours. You give us permission to store and process them only to run
        the service for you and the people you share with. You must have the right to upload the data you upload and to
        connect the databases you connect.
      </p>
      <h2>Acceptable use</h2>
      <p>
        Do not use GridZero to break the law, to attack or probe other systems (including through the Python runner or
        database connections), to get around its limits or sandbox, or to store data you are not allowed to share with
        us. We may suspend accounts that do.
      </p>
      <h2>Ending</h2>
      <p>
        You can delete your account at any time from the Account page. We will give notice before ending the beta where
        we can, so you have time to download your data.
      </p>
      <h2>Liability</h2>
      <p>To the extent the law allows, {OPERATOR} is not liable for lost data, lost profits or indirect losses from using the beta.</p>
      <h2>Contact</h2>
      <p>{CONTACT}</p>
    </>
  );
}

function Privacy() {
  return (
    <>
      <h1>Privacy notice</h1>
      <p className="legal-meta">Last updated {UPDATED}</p>
      <h2>What we keep</h2>
      <ul>
        <li>Your account: name, email address and a hash of your password.</li>
        <li>Your work: workbooks, imported files, comments, saved versions and Python code.</li>
        <li>Database connections you save: host, user and settings, with the password or key encrypted (AES-256-GCM).</li>
        <li>A log of sharing, copies, deletions and connection events on your workbooks.</li>
        <li>Error reports from the app (what failed, the page and browser), to fix problems.</li>
      </ul>
      <h2>Where it goes</h2>
      <ul>
        <li>Hosting: Railway, in the United States.</li>
        <li>Error reports: Sentry, when enabled.</li>
        <li>Invitation and account email: Resend, when enabled.</li>
        <li>Databases you connect: only the queries you write, run with the credentials you give.</li>
      </ul>
      <p>We do not sell your data or use it for advertising. We look at your workbooks only when you ask us to, or to deal with abuse or a legal requirement.</p>
      <h2>Cookies</h2>
      <p>One sign-in cookie, needed to keep you logged in. No tracking or advertising cookies.</p>
      <h2>How long</h2>
      <p>
        Until you delete it. Deleting a workbook moves it to the trash for 7 days, then removes it. Deleting your account
        removes everything at once. Backups are kept for up to 90 days, so copies there expire within that time.
      </p>
      <h2>Your rights</h2>
      <p>You can download your sheets, change or delete your data, and delete your account yourself. For anything else, write to {CONTACT}.</p>
    </>
  );
}

export function LegalPage({ doc }: { doc: "terms" | "privacy" }) {
  return (
    <main className="legal-page">
      <p><Link to="/">← GridZero</Link></p>
      {doc === "terms" ? <Terms /> : <Privacy />}
      <p className="legal-meta">
        <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link>
      </p>
    </main>
  );
}
