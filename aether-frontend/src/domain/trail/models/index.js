/**
 * Trail Domain Models
 * 
 * Exports all trail hierarchy models for easy import.
 * 
 * @.architecture
 * Incoming: trail_schema_architecture.yaml --- {Dict, yaml}
 * Processing: Export domain models for trail hierarchy --- {1 job: JOB_DELEGATE_TO_MODULE}
 * Outgoing: domain/trail consumers --- {object, javascript_module}
 */

'use strict';

const { Group } = require('./Group.js');
const { Subgroup } = require('./Subgroup.js');
const { Node } = require('./Node.js');

module.exports = {
  Group,
  Subgroup,
  Node,
};
