/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* Shared modules for microservices of Melinda record batch import system
*
* Copyright (C) 2018 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-record-import-commons
*
* melinda-record-import-commons program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-record-import-commons is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
* @licend  The above is the entire license notice
* for the JavaScript code in this file.
*
*/

/* Not sure why this is needed only in this module... */
/* eslint-disable import/default */

import amqp from 'amqplib';
import {checkEnv as checkEnvShared, createLogger} from './common';
import {BLOB_STATE} from './constants';
import createApiClient from './api-client';

export function checkEnv() {
	checkEnvShared([
		'API_URL',
		'API_USERNAME',
		'API_PASSWORD',
		'BLOB_ID',
		'AMQP_URL',
		'PROFILE_ID'
	]);
}

export async function startTransformation({callback, blobId, profile, apiURL, apiUsername, apiPassword, amqpURL, abortOnInvalid = false}) {
	const logger = createLogger();
	const connection = await amqp.connect(amqpURL);
	const client = createApiClient({apiURL, apiUsername, apiPassword});
	const readStream = await client.readBlobContent(blobId);

	logger.info(`Starting transformation for blob ${blobId}`);
	const records = await callback(readStream);

	const failedRecords = records.filter(r => r.validation.failed);

	await client.updateBlobMetadata({
		state: BLOB_STATE.transformed,
		numberOfRecords: records.length,
		failedRecords
	});

	logger.info('Transformation done');

	if (!abortOnInvalid || failedRecords.length === 0) {
		const channel = await connection.createChannel();

		await channel.assertQueue(profile, {durable: true});
		await channel.assertExchange(blobId, 'direct', {autoDelete: true});
		await channel.bindQueue(profile, blobId, blobId);

		const count = await sendRecords(channel, records.filter(r => !r.validation.failed));

		await channel.unbindQueue(profile, blobId, blobId);
		await channel.close();
		await connection.close();

		logger.info(`${count} records sent to queue ${profile}`);
	}

	async function sendRecords(channel, records, count = 0) {
		const record = records.shift();

		if (record) {
			const message = Buffer.from(JSON.stringify(record));
			logger.debug('Sending a record to the queue');
			await channel.publish(blobId, blobId, message, {persistent: true});
			return sendRecords(channel, records, count + 1);
		}
		return count;
	}
}

export async function runValidation(validateFunc, records, fix = false) {
	const opts = fix ? {fix: true, validateFixes: true} : {fix: false};
	const results = await Promise.all(
		records.map(r => validateFunc(r, opts))
	);

	return results.map(result => ({
		record: result.record,
		failed: !result.valid,
		messages: result.report
	}));
}
