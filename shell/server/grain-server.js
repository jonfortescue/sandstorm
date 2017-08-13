// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const Crypto = Npm.require("crypto");
import { send as sendEmail } from "/imports/server/email.js";

const ROOT_URL = process.env.ROOT_URL;

const emailLinkWithInlineStyle = function (url, text) {
  return "<a href='" + url + "' style='display:inline-block;text-decoration:none;" +
   "font-family:sans-serif;width:200px;min-height:30px;line-height:30px;" +
   "border-radius:4px;text-align:center;background:#762F87;color:white'>" +
   text + "</a>";
};

Meteor.publish("grainTopBar", function (grainId) {
  check(grainId, String);

  const result = [
    Grains.find({
      _id: grainId,
      $or: [
        { userId: this.userId },
        { private: { $ne: true } },
      ],
    }, {
      fields: {
        title: 1,
        userId: 1,
        private: 1,
      },
    }),
  ];
  if (this.userId) {
    result.push(ApiTokens.find({
      grainId: grainId,
      $or: [
        { "owner.user.accountId": this.userId },
        { accountId: this.userId },
      ],
    }));
  }

  return result;
});

// We allow users to learn package information about a grain they own.
// This is used for obtaining icon and app title information for grains
// you own, which is used in the sidebar. It is not a security/privacy
// risk since it only exposes this information for grains the user owns.
Meteor.publish("packageByGrainId", function (grainId) {
  check(grainId, String);
  const publishThis = [];
  // We need to publish the packageId so that client-side code can
  // find the right package.
  const thisGrainCursor = Grains.find({
    _id: grainId,
    userId: this.userId,
  }, {
    fields: { packageId: 1 },
  });
  publishThis.push(thisGrainCursor);

  if (thisGrainCursor.count()) {
    const thisGrain = thisGrainCursor.fetch()[0];
    const thisPackageCursor = Packages.find({ _id: thisGrain.packageId });
    publishThis.push(thisPackageCursor);
  }

  return publishThis;
});

Meteor.publish("tokenInfo", function (token, isStandalone) {
  // Allows the client side to map a raw token to its entry in ApiTokens, and the additional
  // metadata that it will need to display the app icon and title.  We do not care about making
  // the metadata reactive.
  check(token, String);

  const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
  const apiToken = ApiTokens.findOne({
    _id: hashedToken,
  }, {
    fields: {
      grainId: 1,
      owner: 1,
      revoked: 1,
    },
  });
  if (!apiToken) {
    this.added("tokenInfo", token, { invalidToken: true });
  } else if (apiToken.revoked) {
    this.added("tokenInfo", token, { revoked: true });
  } else {
    const grainId = apiToken.grainId;
    const grain = Grains.findOne({
      _id: grainId,
    }, {
      fields: {
        packageId: 1,
        appId: 1,
        userId: 1,
      },
    });
    if (!grain) {
      this.added("tokenInfo", token, { invalidToken: true });
    } else {
      if (apiToken.owner && apiToken.owner.user) {
        let account = Meteor.users.findOne({_id: apiToken.owner.user.accountId});
        let metadata = apiToken.owner.user.denormalizedGrainMetadata;
        if (account && metadata) {
          account.credentials =
              Meteor.users.find({ _id: { $in: account.loginCredentials.map(cred => cred.id) } })
                  .map(credential => {
            return {
              serviceName: SandstormDb.getServiceName(credential),
              intrinsicName: SandstormDb.getIntrinsicName(credential, true),
              loginId: SandstormDb.getLoginId(credential)
            }
          });

          account.intrinsicNames = globalDb.getAccountIntrinsicNames(account, false);

          this.added("tokenInfo", token, {
            accountOwner: _.pick(account, "_id", "profile", "credentials", "intrinsicNames"),
            grainId: grainId,
            grainMetadata: metadata,
          });
        } else {
          this.added("tokenInfo", token, { invalidToken: true });
        }
      } else if (!apiToken.owner || "webkey" in apiToken.owner) {
        if (this.userId && !isStandalone) {
          const childToken = ApiTokens.findOne({
            "owner.user.accountId": this.userId,
            parentToken: apiToken._id,
          });
          if (childToken || this.userId === grain.userId ||
                            this.userId === apiToken.accountId) {
            this.added("tokenInfo", token, { alreadyRedeemed: true, grainId: apiToken.grainId, });
            this.ready();
            return;
          }
        }

        let pkg = Packages.findOne({ _id: grain.packageId }, { fields: { manifest: 1 } });
        let appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle) || { defaultText: "" };
        let appIcon = undefined;
        if (pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.icons) {
          let icons = pkg.manifest.metadata.icons;
          appIcon = icons.grain || icons.appGrid;
        }

        let denormalizedGrainMetadata = {
          appTitle: appTitle,
          icon: appIcon,
          appId: appIcon ? undefined : grain.appId,
        };
        this.added("tokenInfo", token, {
          webkey: true,
          grainId: grainId,
          grainMetadata: denormalizedGrainMetadata,
        });
      } else {
        this.added("tokenInfo", token, { invalidToken: true });
      }
    }
  }

  this.ready();
  return;
});

Meteor.publish("requestingAccess", function (grainId) {
  check(grainId, String);

  if (!this.userId) {
    throw new Meteor.Error(403, "Must be logged in to request access.");
  }

  const grain = globalDb.getGrain(grainId);
  if (!grain) {
    throw new Meteor.Error(404, "Grain not found.");
  }

  if (grain.userId === this.userId) {
    this.added("grantedAccessRequests", Random.id(), { grainId: grainId });
  }

  const _this = this;
  const query = ApiTokens.find({
    grainId: grainId,
    accountId: grain.userId,
    parentToken: { $exists: false },
    "owner.user.accountId": this.userId,
    revoked: { $ne: true },
  });
  const handle = query.observe({
    added(apiToken) {
      _this.added("grantedAccessRequests", Random.id(), { grainId: grainId });
    },
  });

  this.onStop(() => handle.stop());
});

const GRAIN_DELETION_MS = 1000 * 60 * 60 * 24 * 30; // thirty days
SandstormDb.periodicCleanup(86400000, () => {
  const trashExpiration = new Date(Date.now() - GRAIN_DELETION_MS);
  globalDb.removeApiTokens({ trashed: { $lt: trashExpiration } });
  globalDb.deleteGrains({ trashed: { $lt: trashExpiration } }, globalBackend, "grain");
});

Meteor.methods({
  updateGrainTitle: function (grainId, newTitle, obsolete) {
    check(grainId, String);
    check(newTitle, String);
    if (this.userId) {
      const grain = Grains.findOne(grainId);
      if (grain) {
        if (grain.userId === this.userId) {
          Grains.update({ _id: grainId, userId: this.userId }, { $set: { title: newTitle } });

          // Denormalize new title out to all sharing tokens.
          ApiTokens.update({ grainId: grainId, "owner.user": { $exists: true } },
                           { $set: { "owner.user.upstreamTitle": newTitle } },
                           { multi: true });
        } else {
          const token = ApiTokens.findOne({
            grainId: grainId,
            objectId: { $exists: false },
            "owner.user.accountId": this.userId,
          }, {
            sort: { created: 1 }, // The oldest token is our source of truth for the name.
          });
          if (token && token.owner.user.title !== newTitle) {
            if (token.owner.user.upstreamTitle === newTitle) {
              // User renamed grain to match upstream title. Act like they never renamed it at
              // all.
              ApiTokens.update({
                grainId: grainId,
                "owner.user.accountId": this.userId,
              }, {
                $set: { "owner.user.title": newTitle },
                $unset: { "owner.user.upstreamTitle": 1, "owner.user.renamed": 1 },
              }, {
                multi: true,
              });
            } else {
              const modification = {
                "owner.user.title": newTitle,
                "owner.user.renamed": true,
              };

              if (!token.owner.user.upstreamTitle) {
                // If `upstreamTitle` isn't present then it is equal to the old title.
                modification["owner.user.upstreamTitle"] = token.owner.user.title;
              }

              ApiTokens.update({ grainId: grainId, "owner.user.accountId": this.userId },
                               { $set: modification },
                               { multi: true });
            }
          }
        }
      }
    }
  },

  privatizeGrain: function (grainId) {
    check(grainId, String);
    if (this.userId) {
      Grains.update({ _id: grainId, userId: this.userId }, { $set: { private: true } });
    }
  },

  inviteUsersToGrain: function (_origin, obsolete, grainId, title, roleAssignment,
                                contacts, message) {
    if (typeof message === "object") {
      // Older versions of the client passed an object here, but we only care about the `text`
      // parameter. (This block can eventually be removed.)
      message = message.text;
    }

    if (!this.isSimulation) {
      check(_origin, String);
      check(grainId, String);
      check(title, String);
      check(roleAssignment, roleAssignmentPattern);
      check(contacts, [
        {
          _id: String,
          isDefault: Match.Optional(Boolean),
          profile: Match.ObjectIncluding({
            service: Match.Optional(String),
            name: String,
            intrinsicName: Match.Optional(String),
          }),
          intrinsicNames: [Object]
        },
      ]);
      check(message, String);
      if (!this.userId) {
        throw new Meteor.Error(403, "Must be logged in to share by email.");
      }

      if (contacts.length === 0) {
        throw new Meteor.Error(400, "No contacts were provided.");
      }

      if (globalDb.isDemoUser()) {
        throw new Meteor.Error(403, "Demo users are not allowed to share by email.");
      }

      const escapedMessage = message.replace(/&/g, "&amp;")
                                    .replace(/</g, "&lt;")
                                    .replace(/>/g, "&gt;")
                                    .replace(/"/g, "&quot;")
                                    .replace(/\n/g, "<br>");

      const accountId = this.userId;
      const outerResult = { successes: [], failures: [] };
      const fromEmail = globalDb.getReturnAddressWithDisplayName(accountId);
      const replyTo = globalDb.getPrimaryEmail(accountId);
      contacts.forEach(function (contact) {
        if (contact.isDefault) {
          const emailAddress = contact.profile.name;
          const result = SandstormPermissions.createNewApiToken(
            globalDb, { accountId: accountId }, grainId,
            "email invitation for " + emailAddress,
            roleAssignment, { webkey: { forSharing: true } });
          const url = ROOT_URL + "/shared/" + result.token;
          const html = escapedMessage + "<br><br>" +
              emailLinkWithInlineStyle(url, "Open Shared Grain") +
              "<div style='font-size:8pt;font-style:italic;color:gray'>" +
              "Note: If you forward this email to other people, they will be able to access " +
              "the share as well. To prevent this, remove the button before forwarding.</div>";
          try {
            globalDb.incrementDailySentMailCount(accountId);
            sendEmail({
              to: emailAddress,
              from: fromEmail,
              replyTo: replyTo,
              subject: title + " - Invitation to collaborate",
              text: message + "\n\nFollow this link to open the shared grain:\n\n" + url +
                "\n\nNote: If you forward this email to other people, they will be able to " +
                "access the share as well. To prevent this, remove the link before forwarding.",
              html: html,
            });
          } catch (e) {
            console.error(e.stack);
            outerResult.failures.push({ contact: contact, error: e.toString() });
          }
        } else {
          let result = SandstormPermissions.createNewApiToken(
            globalDb, { accountId: accountId }, grainId,
            "direct invitation to " + contact.profile.name,
            roleAssignment, { user: { accountId: contact._id, title: title } });
          const url = ROOT_URL + "/shared/" + result.token;
          try {
            const account = Meteor.users.findOne({ _id: contact._id });
            const email = _.findWhere(SandstormDb.getUserEmails(account),
                                      { primary: true });
            if (email) {
              const intrinsicName = contact.profile.intrinsicName;

              const html = escapedMessage + "<br><br>" +
                  emailLinkWithInlineStyle(url, "Open Shared Grain") +
                  "<div style='font-size:8pt;font-style:italic;color:gray'>";
              globalDb.incrementDailySentMailCount(accountId);
              sendEmail({
                to: email.email,
                from: fromEmail,
                replyTo: replyTo,
                subject: title + " - Invitation to collaborate",
                text: message + "\n\nFollow this link to open the shared grain:\n\n" + url,
                html: html,
              });
            } else {
              outerResult.failures.push({ contact: contact, warning: "User does not have a " +
                "verified email, so notification of this share was not sent to them. Please " +
                "manually share " + url + " with them.", });
            }
          } catch (e) {
            console.error(e.stack);
            outerResult.failures.push({ contact: contact, error: e.toString(),
              warning: "Share succeeded, but there was an error emailing the user. Please " +
              "manually share " + url + " with them.", });
          }
        }
      });

      return outerResult;
    }
  },

  requestAccess: function (_origin, grainId, obsolete) {
    check(_origin, String);
    check(grainId, String);
    if (!this.isSimulation) {
      if (!this.userId) {
        throw new Meteor.Error(403, "Must be logged in to request access.");
      }

      const grain = Grains.findOne(grainId);
      if (!grain) {
        throw new Meteor.Error(404, "No such grain");
      }

      const grainOwner = globalDb.getUser(grain.userId);
      const email = _.findWhere(SandstormDb.getUserEmails(grainOwner), { primary: true });
      if (!email) {
        throw new Meteor.Error("no email", "Grain owner has no email address.");
      }

      const emailAddress = email.email;

      globalDb.addContact(grainOwner._id, this.userId);

      const fromEmail = globalDb.getReturnAddressWithDisplayName(this.userId);
      const replyTo = globalDb.getPrimaryEmail(this.userId);

      // TODO(soon): In the HTML version, we should display an identity card.
      const identityNotes = [];
      globalDb.getAccountIntrinsicNames(Meteor.user(), true).forEach(intrinsic => {
        // TODO(cleanup): Don't switch on service here; extend getAccountIntrinsicNames or
        //   Account.loginServices to cover what we need.
        if (intrinsic.service === "google") {
          identityNotes.push(intrinsic.name);
        } else if (intrinsic.service === "github") {
          identityNotes.push(intrinsic.name + " on GitHub");
        } else if (intrinsic.service === "email") {
          identityNotes.push(intrinsic.name);
        } else if (intrinsic.service === "ldap") {
          identityNotes.push(intrinsic.name + " on LDAP");
        } else if (intrinsic.service === "saml") {
          identityNotes.push(intrinsic.name + " on SAML");
        }
      });

      const identityNote = identityNotes.length === 0 ? "" :
          " (" + identityNotes.join(", ") + ")";

      const message = Meteor.user().profile.name + identityNote +
            " is requesting access to your grain: " + grain.title + ".";

      const url = ROOT_URL + "/share/" + grainId + "/" + this.userId;

      let html = message + "<br><br>" +
          emailLinkWithInlineStyle(url, "Open Sharing Menu");

      const user = Meteor.user();
      const ACCESS_REQUEST_LIMIT = 10;
      let resetCount = true;
      if (user.accessRequests) {
        if (user.accessRequests.resetOn < new Date()) {
          Meteor.users.update({ _id: user._id }, { $unset: { accessRequests: 1 } });
        } else if (user.accessRequests.count >= ACCESS_REQUEST_LIMIT) {
          throw new Meteor.Error(403, "For spam control reasons, you are not allowed to make " +
                                 "more than " + ACCESS_REQUEST_LIMIT +
                                 " access requests per day.");
        } else {
          resetCount = false;
        }
      }

      let modifier = { $inc: { "accessRequests.count": 1 } };
      if (resetCount) {
        let tomorrow = new Date(Date.now() + 86400000);
        modifier.$set = { "accessRequests.resetOn": tomorrow };
      }

      Meteor.users.update({ _id: user._id }, modifier);

      sendEmail({
        to: emailAddress,
        from: fromEmail,
        replyTo: replyTo,
        subject: grain.title + " - Request for access",
        text: message + "\n\nFollow this link to share access:\n\n" + url,
        html: html,
      });
    }
  },
});
