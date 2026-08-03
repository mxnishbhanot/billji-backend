import mongoose from 'mongoose';

// Phase 0 of offline mode: every collection a device will sync needs four things —
// a tombstone (so deletes can travel in a delta stream), a monotonic version (so two
// devices editing the same record produce a detectable conflict instead of a silent
// clobber), a client-generated id (so a retried create cannot duplicate), and a cursor
// index (so a delta pull is a range scan rather than a collection scan).
//
// One plugin rather than eight copies of the same fields, because the sync protocol has
// to treat every syncable collection identically — a field that exists on seven models
// and not the eighth is a sync bug waiting for its collection.

// Reads skip tombstones unless the caller opts in with .setOptions({ includeDeleted: true }).
// The sync pull is the only thing that should ever opt in: it needs the tombstones.
export const INCLUDE_DELETED = 'includeDeleted';

const READ_HOOKS = [
  'count',
  'countDocuments',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne'
];

const WRITE_HOOKS = ['findOneAndReplace', 'findOneAndUpdate', 'replaceOne', 'updateMany', 'updateOne'];

const hidesTombstones = (query) => {
  if (query.getOptions()?.[INCLUDE_DELETED]) return false;
  // A caller that names deletedAt explicitly knows what it wants.
  return query.getFilter()?.deletedAt === undefined;
};

export const syncable = (schema, { softDelete = true, clientId = true } = {}) => {
  const fields = {
    // Server version at the last write. The client sends the version its edit was based
    // on; a mismatch is a conflict. Deliberately not Mongoose's __v, which only tracks
    // array-position safety and is not incremented by query-path updates.
    version: { type: Number, min: 1 }
  };

  if (softDelete) {
    fields.deletedAt = { type: Date, default: null, index: true };
    fields.deletedBy = { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null };
  }

  if (clientId) {
    // UUIDv7 minted on the device, echoed back on create so the device can map its local
    // row to the server record. No default: the field stays absent on server-created
    // records, which is what keeps the partial unique index below from colliding.
    fields.clientId = { type: String, trim: true, maxlength: 64 };
  }

  schema.add(fields);

  // Version is set here rather than as a schema default so that upserts do not end up
  // with Mongoose's setDefaultsOnInsert writing `version` in $setOnInsert while the hook
  // below writes it in $inc — MongoDB rejects that as a conflicting path.
  schema.pre('validate', function initVersion() {
    if (this.version == null) this.version = 1;
  });

  schema.pre('save', function bumpVersionOnSave() {
    if (!this.isNew) this.version += 1;
  });

  schema.pre(WRITE_HOOKS, function bumpVersionOnUpdate() {
    const update = this.getUpdate();
    if (!update) return;

    if (Array.isArray(update)) {
      // Aggregation-pipeline update.
      update.push({ $set: { version: { $add: [{ $ifNull: ['$version', 1] }, 1] } } });
      return;
    }

    const isReplacement = !Object.keys(update).some((key) => key.startsWith('$'));
    if (isReplacement) {
      update.version = (Number(update.version) || 1) + 1;
      this.setUpdate(update);
      return;
    }

    // Version is server-owned: a caller cannot pin or rewind it.
    if (update.$set) delete update.$set.version;
    if (update.$setOnInsert) delete update.$setOnInsert.version;
    update.$inc = { ...update.$inc, version: 1 };
    this.setUpdate(update);
  });

  if (softDelete) {
    schema.pre(READ_HOOKS, function excludeTombstones() {
      if (hidesTombstones(this)) this.where({ deletedAt: null });
    });

    schema.pre('aggregate', function excludeTombstonesFromAggregate() {
      if (this.options?.[INCLUDE_DELETED]) return;
      this.pipeline().unshift({ $match: { deletedAt: null } });
    });

    schema.methods.softDelete = function softDeleteDocument({ userId = null, session } = {}) {
      this.deletedAt = new Date();
      this.deletedBy = userId;
      return this.save({ session });
    };

    // Returns null when nothing matched — including when the record was already
    // tombstoned, because the read hook above filters it out. Callers keep their
    // existing "not found" branch unchanged.
    schema.statics.softDeleteOne = function softDeleteOneDocument(filter, { userId = null, session } = {}) {
      return this.findOneAndUpdate(
        filter,
        { $set: { deletedAt: new Date(), deletedBy: userId } },
        { new: true, session }
      );
    };
  }

  // The delta-pull cursor: (business, updatedAt, _id) ascending, so a page resumes from
  // the last (updatedAt, _id) it saw instead of paying for skip/limit.
  schema.index({ business: 1, updatedAt: 1, _id: 1 });

  if (clientId) {
    // Partial rather than sparse: sparse only skips missing fields, so two records with
    // an explicit null clientId would still collide.
    schema.index(
      { business: 1, clientId: 1 },
      { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
    );
  }
};

// Business-scoped unique indexes must not count tombstones, or a user who deletes a
// product and re-creates it with the same SKU gets a duplicate-key error naming a record
// they cannot see. Every unique index on a soft-deletable collection goes through here.
export const liveUniqueIndex = (extraFilter = {}) => ({
  unique: true,
  partialFilterExpression: { deletedAt: null, ...extraFilter }
});
